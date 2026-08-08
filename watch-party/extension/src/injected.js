/*
 * Couch - injected page-context script.
 *
 * Runs in the streaming site's main world (NOT the isolated content-script
 * world) so it can reach page globals like `netflix.appContext` and drive the
 * real player. It talks to content.js exclusively through window.postMessage.
 *
 * Protocol
 *   page  -> content : { source: 'couch-page',    type, ... }
 *   content -> page  : { source: 'couch-content', type, ... }
 *
 * Two things here are subtler than they look, and both were real bugs:
 *
 * 1. WHICH <video>. Prime Video, Hotstar and YouTube all keep several <video>
 *    elements in the DOM at once (content, ad, trailer/preview, and sometimes a
 *    detached one left over from the previous title). `querySelector('video')`
 *    returns the first in DOM order, which is regularly NOT the one playing, so
 *    we would bind listeners to a dead element: the local user pauses, no event
 *    ever fires, nothing is sent, and the show keeps playing for everyone else.
 *    We score the candidates and pick the real one instead.
 *
 * 2. AD BREAKS. During an ad the player's currentTime is the AD's timeline, not
 *    the content's. Two people on different tiers (or just different ad pods)
 *    are therefore reading two unrelated clocks, and any sync between them
 *    seeks both parties into garbage. We detect ads, freeze the last known
 *    content time, stop emitting while in one, and tell peers so they can wait.
 */
(function () {
  'use strict';

  // Guard against double injection (SPA navigations can re-run scripts).
  if (window.__couchInjected) return;
  window.__couchInjected = true;

  // While we are applying a *remote* command we must ignore the native
  // play/pause/seek events it generates, otherwise we echo them back to peers
  // and create an infinite feedback loop. We suppress for a short window.
  let suppressUntil = 0;
  const SUPPRESS_MS = 1200;
  // How far out of step we tolerate before a silent correction. Below this,
  // seeking is more disruptive than the drift itself.
  const DRIFT_TOLERANCE_MS = 2500;
  const suppress = () => { suppressUntil = Date.now() + SUPPRESS_MS; };
  const isSuppressed = () => Date.now() < suppressUntil;

  // Are we inside an ad break right now? Declared up here (not next to the
  // watcher that maintains it) because the play/pause handlers below read it,
  // and a `let` referenced before its declaration is a ReferenceError.
  let inAd = false;

  function send(msg) {
    window.postMessage(Object.assign({ source: 'couch-page' }, msg), '*');
  }

  // ---- Player discovery -------------------------------------------------------

  function getNetflixPlayer() {
    try {
      const api = window.netflix &&
        window.netflix.appContext &&
        window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      if (!api) return null;
      const ids = api.getAllPlayerSessionIds() || [];
      // Prefer a "watch" session id; fall back to the first available.
      const id = ids.find((s) => String(s).startsWith('watch-')) || ids[0];
      if (!id) return null;
      return api.getVideoPlayerBySessionId(id) || null;
    } catch (e) {
      return null;
    }
  }

  // Score every <video> and return the one the user is actually watching.
  // Higher is better; anything with a zero-area box or no loaded metadata is
  // almost certainly a preview, a placeholder, or a detached leftover.
  function scoreVideo(v) {
    let score = 0;
    let rect;
    try { rect = v.getBoundingClientRect(); } catch (e) { return -1; }
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    if (area <= 0) return -1;                       // not on screen at all
    score += Math.min(area / 1000, 500);            // bigger box wins, capped
    if (!v.paused && !v.ended) score += 1200;       // actually playing wins hard
    if (v.readyState >= 2) score += 400;            // has current data
    if (v.currentTime > 0) score += 200;
    if (isFinite(v.duration) && v.duration > 0) score += 200;
    if (v.muted && v.paused) score -= 150;          // muted+paused smells like a preview
    return score;
  }

  function getVideoEl() {
    const all = Array.prototype.slice.call(document.querySelectorAll('video'));
    if (!all.length) return null;
    if (all.length === 1) return all[0];
    let best = null;
    let bestScore = -Infinity;
    for (const v of all) {
      const s = scoreVideo(v);
      if (s > bestScore) { bestScore = s; best = v; }
    }
    return bestScore < 0 ? null : best;
  }

  // ---- Ad detection -----------------------------------------------------------
  //
  // Each platform marks ad playback differently and none of it is a public API,
  // so this is a best-effort DOM sniff per site plus a platform-agnostic
  // fallback. Being wrong in the "no ad" direction just means we behave like
  // before; being wrong in the "ad" direction only pauses people briefly, so we
  // bias towards specific selectors over aggressive guessing.
  const AD_SELECTORS = [
    // Prime Video (atvwebplayersdk-*)
    '[class*="atvwebplayersdk-ad-timer"]',
    '[class*="atvwebplayersdk-adtimer"]',
    '[class*="atvwebplayersdk"][class*="adbadge"]',
    '.adSkipButton, [data-testid*="ad-countdown"], [data-testid*="adCountdown"]',
    // YouTube
    '.ad-showing', '.ytp-ad-player-overlay', '.ytp-ad-text',
    // Netflix
    '[data-uia*="ad-break"]', '[data-uia*="advertisement"]',
    // Hotstar / JioHotstar
    '[class*="ad-countdown"]', '[class*="adCountdown"]', '[data-testid*="ad-badge"]',
    // ZEE5 / SonyLIV / generic players
    '[class*="ad-overlay"]', '[id*="ad-countdown"]',
  ];

  // Longest content duration we have seen on this page. An ad creative is short
  // (typically 6-60s), so a sudden collapse from a feature-length duration to a
  // very short one is a strong ad signal even when the DOM gives us nothing.
  let knownContentDurationMs = 0;

  function adByDom() {
    for (const sel of AD_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        // Require it to be rendered: these nodes often exist but stay hidden.
        if (el && el.getBoundingClientRect().height > 0) return true;
      } catch (e) { /* bad selector on an old engine; ignore */ }
    }
    return false;
  }

  function adByDuration(video) {
    if (!video || !isFinite(video.duration) || video.duration <= 0) return false;
    const durMs = video.duration * 1000;
    if (durMs > knownContentDurationMs) knownContentDurationMs = durMs;
    // Only meaningful once we have actually seen real content (>10 min) and the
    // current media is far shorter (<3 min).
    return knownContentDurationMs > 10 * 60 * 1000 && durMs < 3 * 60 * 1000;
  }

  function isInAd() {
    const video = getVideoEl();
    return adByDom() || adByDuration(video);
  }

  // ---- Content time ----------------------------------------------------------
  //
  // The last position we believe is on the CONTENT timeline. During an ad the
  // player's clock belongs to the ad, so we stop updating this and keep
  // reporting the frozen value: that is what peers need to resync to afterwards.
  let lastContentTimeMs = 0;

  function rawTimeMs() {
    const player = getNetflixPlayer();
    if (player && player.getCurrentTime) {
      const t = player.getCurrentTime();
      if (typeof t === 'number' && t >= 0) return t;
    }
    const video = getVideoEl();
    return video ? Math.round(video.currentTime * 1000) : 0;
  }

  function currentTimeMs() {
    if (inAd) return lastContentTimeMs;
    const t = rawTimeMs();
    lastContentTimeMs = t;
    return t;
  }

  // ---- Apply commands coming from peers --------------------------------------

  // A command that arrived while we were in an ad. We cannot honour it yet (our
  // clock is the ad's), so we hold it and apply it the moment the ad ends.
  let pendingCmd = null;

  function seekTo(player, video, timeMs) {
    if (player && player.seek) player.seek(timeMs);
    else if (video) video.currentTime = timeMs / 1000;
  }

  function applyCommand(cmd) {
    // Never fight an ad break. Queue and apply on the far side of it.
    if (inAd && cmd.action !== 'pause') { pendingCmd = cmd; return; }

    const player = getNetflixPlayer();
    const video = getVideoEl();
    if (!player && !video) return;
    suppress();

    try {
      if (cmd.action === 'seek' && typeof cmd.timeMs === 'number') {
        seekTo(player, video, cmd.timeMs);
        lastContentTimeMs = cmd.timeMs;
      }
      if (cmd.action === 'play') {
        // Re-sync time first so a long-paused viewer catches up.
        if (typeof cmd.timeMs === 'number') {
          seekTo(player, video, cmd.timeMs);
          lastContentTimeMs = cmd.timeMs;
        }
        const p = player && player.play ? player.play() : (video && video.play());
        // Chrome rejects play() without a gesture; surface it instead of
        // silently leaving this viewer behind and out of sync.
        if (p && typeof p.catch === 'function') {
          p.catch(() => send({ type: 'blocked', reason: 'autoplay' }));
        }
      }
      if (cmd.action === 'pause') {
        if (player && player.pause) player.pause();
        else if (video) video.pause();
        if (typeof cmd.timeMs === 'number' && !inAd) {
          seekTo(player, video, cmd.timeMs);
          lastContentTimeMs = cmd.timeMs;
        }
      }
    } catch (e) {
      // Player API can throw during ad/credit transitions; ignore.
    }
  }

  // ---- Report local user actions to content.js -------------------------------

  function emitState(action) {
    if (isSuppressed()) return;
    // Our clock is the ad's right now. Emitting it would drag everyone else to
    // a meaningless position, which is exactly the desync we are fixing.
    if (inAd) return;
    const video = getVideoEl();
    send({
      type: 'state',
      action: action,
      paused: video ? video.paused : true,
      timeMs: currentTimeMs(),
    });
  }

  // Listen on the document in the CAPTURE phase. media events do not bubble, but
  // capture-phase listeners on an ancestor still see them, so this catches every
  // <video> on the page including ones mounted later. That is what makes pause
  // propagate on Prime, where the element we care about is swapped out under us.
  const onMediaEvent = (type) => (ev) => {
    const target = ev.target;
    if (!target || target.tagName !== 'VIDEO') return;
    // Ignore events from the videos we are not tracking (ad creatives, previews).
    if (target !== getVideoEl()) return;
    emitState(type);
  };
  document.addEventListener('play', onMediaEvent('play'), true);
  document.addEventListener('pause', onMediaEvent('pause'), true);
  document.addEventListener('seeked', onMediaEvent('seek'), true);

  // ---- Ad break watcher -------------------------------------------------------

  const adPoll = setInterval(() => {
    const nowInAd = isInAd();
    if (nowInAd === inAd) {
      // Keep the content clock warm while playing normally.
      if (!inAd) currentTimeMs();
      return;
    }
    inAd = nowInAd;
    if (inAd) {
      // Freeze the content position at the last good value and tell peers, so
      // they can hold rather than drift ahead by the length of our ad break.
      send({ type: 'ad', inAd: true, timeMs: lastContentTimeMs });
    } else {
      // Ad finished. Our clock is the content's again. Apply anything that came
      // in while we were away, then publish where we actually are.
      lastContentTimeMs = rawTimeMs();
      send({ type: 'ad', inAd: false, timeMs: lastContentTimeMs });
      if (pendingCmd) { const c = pendingCmd; pendingCmd = null; applyCommand(c); }
    }
  }, 1000);

  // Tell content.js as soon as a real player exists, so it can enable sync UI.
  let announced = false;
  const findInterval = setInterval(() => {
    if (announced) return;
    if (getVideoEl()) { announced = true; send({ type: 'ready' }); }
  }, 1000);

  window.addEventListener('beforeunload', () => {
    clearInterval(findInterval);
    clearInterval(adPoll);
  });

  // ---- Inbound messages from content.js --------------------------------------

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'couch-content') return;

    if (data.type === 'command') {
      applyCommand(data.cmd || {});
    } else if (data.type === 'request-position') {
      // Host-side heartbeat source. Deliberately a different message from
      // 'request-state' because a state reply gets broadcast as a sync command,
      // and we do not want a routine position check to yank everyone's player.
      const video = getVideoEl();
      send({
        type: 'position',
        timeMs: currentTimeMs(),
        paused: video ? video.paused : true,
        inAd: inAd,
      });
    } else if (data.type === 'drift') {
      // Gentle correction only. Ads have their own clock, and a paused viewer
      // is usually paused on purpose, so we leave both alone.
      if (inAd || data.paused) return;
      const video = getVideoEl();
      if (!video || video.paused) return;
      if (typeof data.timeMs !== 'number') return;
      if (Math.abs(rawTimeMs() - data.timeMs) <= DRIFT_TOLERANCE_MS) return;
      suppress();
      seekTo(getNetflixPlayer(), video, data.timeMs);
      lastContentTimeMs = data.timeMs;
    } else if (data.type === 'request-state') {
      // A peer (re)joined and asked for the authoritative current state.
      const video = getVideoEl();
      send({
        type: 'state',
        action: 'sync',
        paused: video ? video.paused : true,
        timeMs: currentTimeMs(),
        inAd: inAd,
      });
    }
  });

  send({ type: 'hello' });
})();
