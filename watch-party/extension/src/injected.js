/*
 * Couch — injected page-context script.
 *
 * Runs in Netflix's main world (NOT the isolated content-script world) so it can
 * reach `netflix.appContext` and drive the real player. It talks to content.js
 * exclusively through window.postMessage.
 *
 * Protocol
 *   page  -> content : { source: 'couch-page',    type, ... }
 *   content -> page  : { source: 'couch-content', type, ... }
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
  const suppress = () => { suppressUntil = Date.now() + SUPPRESS_MS; };
  const isSuppressed = () => Date.now() < suppressUntil;

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

  function getVideoEl() {
    return document.querySelector('video');
  }

  function send(msg) {
    window.postMessage(Object.assign({ source: 'couch-page' }, msg), '*');
  }

  // ---- Apply commands coming from peers --------------------------------------

  function applyCommand(cmd) {
    const player = getNetflixPlayer();
    const video = getVideoEl();
    if (!player && !video) return;
    suppress();

    try {
      if (cmd.action === 'seek' && typeof cmd.timeMs === 'number') {
        if (player && player.seek) player.seek(cmd.timeMs);
        else if (video) video.currentTime = cmd.timeMs / 1000;
      }
      if (cmd.action === 'play') {
        // Re-sync time first so a long-paused viewer catches up.
        if (typeof cmd.timeMs === 'number') {
          if (player && player.seek) player.seek(cmd.timeMs);
          else if (video) video.currentTime = cmd.timeMs / 1000;
        }
        if (player && player.play) player.play();
        else if (video) video.play();
      }
      if (cmd.action === 'pause') {
        if (player && player.pause) player.pause();
        else if (video) video.pause();
        if (typeof cmd.timeMs === 'number') {
          if (player && player.seek) player.seek(cmd.timeMs);
          else if (video) video.currentTime = cmd.timeMs / 1000;
        }
      }
    } catch (e) {
      // Player API can throw during ad/credit transitions; ignore.
    }
  }

  // ---- Report local user actions to content.js -------------------------------

  function currentTimeMs() {
    const player = getNetflixPlayer();
    if (player && player.getCurrentTime) {
      const t = player.getCurrentTime();
      if (typeof t === 'number' && t >= 0) return t;
    }
    const video = getVideoEl();
    return video ? Math.round(video.currentTime * 1000) : 0;
  }

  function emitState(action) {
    if (isSuppressed()) return;
    const video = getVideoEl();
    send({
      type: 'state',
      action: action,
      paused: video ? video.paused : true,
      timeMs: currentTimeMs(),
    });
  }

  let boundVideo = null;
  function bindVideo(video) {
    if (!video || video === boundVideo) return;
    boundVideo = video;
    video.addEventListener('play', () => emitState('play'));
    video.addEventListener('pause', () => emitState('pause'));
    video.addEventListener('seeked', () => emitState('seek'));
    send({ type: 'ready' });
  }

  // Netflix mounts/unmounts the <video> across title changes — keep watching.
  const findInterval = setInterval(() => {
    const video = getVideoEl();
    if (video) bindVideo(video);
  }, 1000);
  window.addEventListener('beforeunload', () => clearInterval(findInterval));

  // ---- Inbound messages from content.js --------------------------------------

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'couch-content') return;

    if (data.type === 'command') {
      applyCommand(data.cmd || {});
    } else if (data.type === 'request-state') {
      // A peer (re)joined and asked for the authoritative current state.
      const video = getVideoEl();
      send({
        type: 'state',
        action: 'sync',
        paused: video ? video.paused : true,
        timeMs: currentTimeMs(),
      });
    }
  });

  send({ type: 'hello' });
})();
