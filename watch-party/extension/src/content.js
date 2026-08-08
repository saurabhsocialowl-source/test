/*
 * Couch - content script (isolated world) running on netflix.com/watch/*.
 *
 * Serverless architecture (no backend to host):
 *   - Signaling runs over the free PeerJS public cloud broker (wss). The party
 *     creator registers a deterministic peer id `couch-<ROOMCODE>` and acts as
 *     the rendezvous/discovery point. Joiners reach that id with just the code.
 *   - Once peers discover each other they form a full WebRTC mesh: a data
 *     channel per pair carries playback sync (everyone shares controls) and a
 *     media call per pair carries the audio/video.
 *
 * PeerJS is vendored and loaded as a content script before this file, exposing
 * the global `Peer`.
 */
(function () {
  'use strict';

  if (window.__couchContent) return;
  window.__couchContent = true;

  // Default signaling broker for EVERYONE (host + joiners must share one).
  // Empty string = the free PeerJS public cloud (unreliable / rate-limited).
  // After you deploy signal-server, set this to your host, e.g.
  //   'signal.example.com'   (wss on port 443) - then rebuild and everyone
  // auto-connects through your reliable broker. A per-user override is still
  // available in the popup's Advanced field.
  const DEFAULT_BROKER = 'signal.vermasaurabh.com';

  // Our own TURN relay (coturn on the Hetzner box) so peer connections traverse
  // strict/symmetric NATs. The free public TURN we used before (openrelay) was
  // dead, which is why data channels reached the host but never opened.
  // Use the server's RAW IP for STUN/TURN so it bypasses Cloudflare (which only
  // proxies web ports - port 3478 behind an orange-cloud record is unreachable).
  const TURN_HOST = '89.167.47.11';
  // Short-lived TURN credentials (coturn REST convention: expiring username +
  // HMAC-SHA1 credential), minted per-party by the signal server so no
  // permanent TURN password ships inside the public extension bundle. Falls
  // back to a static credential if the endpoint isn't reachable/deployed yet
  // (e.g. an older signal-server), so this never breaks connectivity.
  const TURN_CREDS_URL = 'https://' + DEFAULT_BROKER + '/turn-creds';
  const TURN_STATIC_FALLBACK = { username: 'couch', credential: 'couch-turn-4Kp9x2Qm' };

  async function fetchTurnCreds() {
    try {
      const res = await fetch(TURN_CREDS_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      if (!data || !data.username || !data.credential) throw new Error('malformed response');
      log('turn-creds: short-lived credential issued (ttl', data.ttl, 's)');
      return { username: data.username, credential: data.credential };
    } catch (e) {
      log('turn-creds fetch failed, using static fallback:', e && e.message);
      return TURN_STATIC_FALLBACK;
    }
  }

  async function buildIceServers() {
    const { username, credential } = await fetchTurnCreds();
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:' + TURN_HOST + ':3478' },
      { urls: 'turn:' + TURN_HOST + ':3478?transport=udp', username, credential },
      { urls: 'turn:' + TURN_HOST + ':3478?transport=tcp', username, credential },
    ];
  }

  // Browsers block autoplay of media WITH audio until the page sees a user
  // gesture. To make peers' video visible immediately, remote tiles start MUTED
  // (muted autoplay is always allowed) and unmute on the first click/keypress.
  // Once that first gesture has happened, the page keeps "user activation" for
  // the rest of the session, so any LATER peer who joins mid-call is unmuted
  // immediately instead of silently waiting for another click.
  const remoteVideos = new Set();
  let gestureHookInstalled = false;
  let audioUnlocked = false;
  function playMedia(v, remote) {
    if (remote) {
      remoteVideos.add(v);
      if (audioUnlocked) v.muted = false;
    }
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
    if (remote && !audioUnlocked) installGestureHook();
  }
  function installGestureHook() {
    if (gestureHookInstalled) return;
    gestureHookInstalled = true;
    toast('Click anywhere to unmute the call');
    const resume = () => {
      audioUnlocked = true;
      remoteVideos.forEach((v) => { v.muted = false; v.play().catch(() => {}); });
      window.removeEventListener('click', resume, true);
      window.removeEventListener('keydown', resume, true);
      gestureHookInstalled = false;
    };
    window.addEventListener('click', resume, true);
    window.addEventListener('keydown', resume, true);
  }

  const state = {
    brokerHost: '',          // '' => PeerJS public cloud
    peer: null,
    peerId: null,
    isHost: false,
    room: null,
    hostId: null,
    name: 'Guest',
    inParty: false,
    connected: false,        // registered with the broker
    micOn: true,
    camOn: true,
    localStream: null,
    members: new Map(),       // peerId -> { name, dataConn, call, stream, tile }
    lastAppliedAt: 0,
    videoId: null,            // Netflix title everyone should be on
    titlePollTimer: null,
    watchdogTimer: null,      // self-healing broker/host reconnection loop
    beaconPeer: null,         // standby "front door" if the real host has left (see below)
    needSyncRequest: false,   // set true after joining via a beacon (no host to ask directly)
    selfInAd: false,          // we are inside an ad break
    peersInAd: new Set(),     // peerIds currently inside an ad break
    heldForAd: false,         // we auto-paused to wait for someone's ad, so we may auto-resume
    driftTimer: null,         // host-side periodic position beacon
  };

  // ------------------------------------------------------------------ utils ---

  // Captured diagnostics log (also mirrored to the DevTools console). Every
  // log() call is recorded so the in-overlay Diagnostics panel can show it and
  // the user can copy it to us - no console spelunking required.
  const diagLog = [];
  function fmtT(t) { const d = new Date(t); return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0'); }
  function log(...a) {
    let line = '';
    try { line = a.map((x) => (x && typeof x === 'object') ? JSON.stringify(x) : String(x)).join(' '); }
    catch (e) { line = a.join(' '); }
    diagLog.push({ t: Date.now(), line });
    if (diagLog.length > 400) diagLog.shift();
    try { console.debug('%c[Couch]', 'color:#0FB5A3', ...a); } catch (e) {}
    try { if (typeof refreshDiag === 'function') refreshDiag(); } catch (e) {}
  }

  // Default length used for freshly-created room codes. 12 chars from this
  // 31-symbol alphabet is ~59 bits of entropy (vs. ~40 bits at the old length
  // of 8) - the room code doubles as the only real access control for who can
  // join (anyone who has it can connect), so it's worth the extra couple of
  // characters. Still short enough to copy/paste comfortably; the invite link
  // (the recommended way to share it) carries it automatically either way.
  function randomId(n = 12) {
    const c = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
  }

  function hostIdFor(room) { return 'couch-' + room.toUpperCase(); }

  // ---- Streaming-platform adapters -------------------------------------------
  // Sync/call/chat are platform-agnostic (HTML5 <video> + WebRTC). Each adapter
  // only defines how to (a) tell we're on a playback page, (b) derive a stable
  // "same title" key from the URL, and (c) rebuild a shareable watch URL.
  const PLATFORMS = [
    { id: 'netflix', label: 'Netflix', host: /(^|\.)netflix\.com$/,
      isWatch: () => /\/watch\//.test(location.pathname),
      key: () => (location.pathname.match(/\/watch\/(\d+)/) || [])[1] || null,
      url: (k) => 'https://www.netflix.com/watch/' + k },

    { id: 'youtube', label: 'YouTube', host: /(^|\.)youtube\.com$/,
      isWatch: () => location.pathname === '/watch' && new URLSearchParams(location.search).has('v'),
      key: () => new URLSearchParams(location.search).get('v'),
      url: (k) => 'https://www.youtube.com/watch?v=' + k },

    { id: 'prime', label: 'Prime Video', host: /(^|\.)primevideo\.com$/,
      isWatch: () => /\/(detail|watch)\//.test(location.pathname) || !!document.querySelector('video'),
      key: () => (location.pathname.match(/\/(?:detail|watch)\/([^/?#]+)/) || [])[1] || location.pathname,
      url: (k) => (String(k).startsWith('/') ? location.origin + k : 'https://www.primevideo.com/detail/' + k) },

    { id: 'hotstar', label: 'JioHotstar', host: /(^|\.)hotstar\.com$|(^|\.)jiohotstar\.com$/,
      isWatch: () => /\/(watch|movies|shows|tv|sports)\//.test(location.pathname),
      key: () => location.pathname,
      url: (k) => location.origin + k },

    { id: 'disneyplus', label: 'Disney+', host: /(^|\.)disneyplus\.com$/,
      isWatch: () => /\/(video|play|movies|series)\//.test(location.pathname),
      key: () => location.pathname,
      url: (k) => location.origin + k },

    { id: 'zee5', label: 'ZEE5', host: /(^|\.)zee5\.com$/,
      isWatch: () => /\/(movies|tvshows|web-series|watch|videos)\//.test(location.pathname),
      key: () => location.pathname,
      url: (k) => location.origin + k },
  ];
  // Fallback: any site with a <video>, keyed by its path - sync still works.
  const GENERIC = { id: 'web', label: 'this site',
    isWatch: () => !!document.querySelector('video'),
    key: () => location.pathname + location.search,
    url: (k) => (String(k).startsWith('/') ? location.origin + k : k) };

  function platform() {
    return PLATFORMS.find((p) => p.host.test(location.hostname)) || GENERIC;
  }
  function onWatchPage() { try { return !!platform().isWatch(); } catch (e) { return false; } }

  // Stable identity of the current title (used to detect "same show").
  function currentVideoId() { try { return platform().key() || null; } catch (e) { return null; } }

  // Build a watch URL for a title key, optionally with the auto-join param.
  function watchUrl(key, room) {
    let u;
    try { u = platform().url(key); } catch (e) { u = location.href; }
    if (room) u += (u.indexOf('?') === -1 ? '?' : '&') + 'couch=' + encodeURIComponent(room);
    return u;
  }
  // Shareable invite: opens the host's title AND auto-joins the party.
  function inviteLink() {
    if (!state.room) return '';
    const vid = state.videoId || currentVideoId();
    return vid ? watchUrl(vid, state.room)
               : location.origin + '/?couch=' + state.room;
  }

  // Remember the active party so we can auto-rejoin after a page navigation
  // (e.g. when a viewer is sent to the host's title).
  function persistActive() {
    try {
      chrome.storage.local.set({
        couchActive: state.inParty ? {
          room: state.room, name: state.name, isHost: state.isHost,
          brokerHost: state.brokerHost, ts: Date.now(),
        } : null,
      });
    } catch (e) {}
  }

  function memberStatus() {
    return [state.name, ...[...state.members.values()].map((m) => m.name)];
  }

  // Real peer IDs of everyone currently in the room except one (used to
  // introduce a newcomer). Shared by the host's own welcome reply and by the
  // standby beacon (see "host resilience" below) so both hand off identical
  // info regardless of who answers the door.
  function membersListExcluding(exceptId) {
    return [...state.members.entries()]
      .filter(([id]) => id !== exceptId)
      .map(([id, mm]) => ({ peerId: id, name: mm.name }));
  }

  function saveStatus() {
    const status = {
      inParty: state.inParty, connected: state.connected, room: state.room,
      name: state.name, micOn: state.micOn, camOn: state.camOn, members: memberStatus(),
      link: inviteLink(), videoId: state.videoId, watch: onWatchPage(),
      platform: platform().label,
    };
    try {
      chrome.storage.local.set({ couchStatus: status });
      chrome.runtime.sendMessage({ type: 'status', status }).catch(() => {});
    } catch (e) {}
  }

  // --------------------------------------------------------- page bridge ------
  // injected.js runs as a `world: "MAIN"` content script (see manifest), so no
  // manual <script> injection is needed - and it isn't blocked by site CSP.

  function sendToPage(msg) {
    window.postMessage(Object.assign({ source: 'couch-content' }, msg), '*');
  }

  // Local playback events from the page -> broadcast to peers.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== 'couch-page') return;
    if (d.type === 'state' && state.inParty) {
      if (Date.now() - state.lastAppliedAt < 400) return; // don't echo applied state
      broadcast({ t: 'sync', action: d.action, paused: d.paused, timeMs: d.timeMs });
    }
    if (d.type === 'ad') {
      // Our own ad break started or ended. Peers cannot see it, so tell them:
      // ad pods differ per account and per tier, and without this the people
      // without an ad simply run ahead by the length of ours.
      state.selfInAd = !!d.inAd;
      if (state.inParty) broadcast({ t: 'ad', inAd: state.selfInAd, timeMs: d.timeMs });
      reconcileAdHold(d.timeMs);
    }
    if (d.type === 'blocked' && d.reason === 'autoplay') {
      toast('Chrome blocked playback. Click the video once to let Couch resume it.');
    }
    if (d.type === 'position' && state.inParty && state.isHost) {
      if (d.inAd || d.paused) return;   // nothing useful to anchor to
      broadcast({ t: 'drift', timeMs: d.timeMs, paused: d.paused });
    }
  });

  // ------------------------------------------------------ drift correction ----
  //
  // Event-driven sync alone lets small gaps accumulate: different buffering,
  // a dropped frame here, a slow seek there. The host publishes its position
  // every few seconds and anyone who has slipped past the tolerance closes the
  // gap quietly. Followers ignore it while paused or inside an ad.

  const DRIFT_BEAT_MS = 5000;

  function startDriftBeat() {
    stopDriftBeat();
    if (!state.isHost) return;
    state.driftTimer = setInterval(() => {
      if (!state.inParty || !state.isHost) return;
      if (state.selfInAd || state.peersInAd.size) return;  // ad logic owns this
      sendToPage({ type: 'request-position' });
    }, DRIFT_BEAT_MS);
  }

  function stopDriftBeat() {
    if (state.driftTimer) { clearInterval(state.driftTimer); state.driftTimer = null; }
  }

  function applyDriftCorrection(msg) {
    if (state.isHost) return;                       // host is the reference
    if (state.selfInAd || state.heldForAd) return;  // ad logic owns this
    sendToPage({ type: 'drift', timeMs: msg.timeMs, paused: msg.paused });
  }

  // ----------------------------------------------------------- ad breaks ------
  //
  // Rule: while ANY participant is inside an ad break, everybody else holds.
  // When the last ad finishes, that viewer's content position is the truth and
  // everyone seeks there and resumes together.

  function anyoneInAd() { return state.selfInAd || state.peersInAd.size > 0; }

  function reconcileAdHold(resumeTimeMs) {
    if (!state.inParty) return;
    if (anyoneInAd()) {
      // Someone is in an ad. If it is not us, hold here until they are back.
      if (!state.selfInAd && !state.heldForAd) {
        state.heldForAd = true;
        applyRemoteSync({ action: 'pause' });
        const who = state.peersInAd.size === 1
          ? (state.members.get([...state.peersInAd][0])?.name || 'Someone')
          : 'Some viewers';
        toast(`${who} hit an ad break. Holding until it finishes.`);
      }
      return;
    }
    // Nobody is in an ad any more.
    if (state.heldForAd) {
      state.heldForAd = false;
      toast('Ad break over. Resuming together.');
      applyRemoteSync({ action: 'play', timeMs: resumeTimeMs });
    }
  }

  // ------------------------------------------------------- PeerJS plumbing ----

  function peerOptions(iceServers) {
    const opts = { debug: 1, config: { iceServers } };
    if (state.brokerHost) {
      // Accept "host", "host:port" or "wss://host:port/path".
      let h = state.brokerHost.replace(/^wss?:\/\//, '');
      let path = '/';
      const slash = h.indexOf('/');
      if (slash !== -1) { path = h.slice(slash); h = h.slice(0, slash); }
      const [host, port] = h.split(':');
      opts.host = host;
      opts.port = port ? Number(port) : 443;
      opts.path = path;
      opts.secure = true;
    }
    return opts;
  }

  async function initPeer() {
    const iceServers = await buildIceServers();
    if (!state.inParty) return; // left the party while credentials were in flight
    const peer = new Peer(state.peerId, peerOptions(iceServers));
    state.peer = peer;

    log('broker connecting via', state.brokerHost || 'peerjs-cloud', 'as', state.peerId, state.isHost ? '(host)' : '(joiner)');

    peer.on('open', (id) => {
      state.peerId = id;
      state.connected = true;
      log('broker OPEN as', id, state.isHost ? '(host)' : '(joiner)');
      if (!state.isHost) connectData(state.hostId); // bootstrap discovery
      toast(state.isHost ? 'Party ready - share the code' : 'Joined - connecting…');
      render(); saveStatus();
    });

    peer.on('connection', (conn) => setupDataConn(conn, /*incoming*/ true));

    peer.on('call', (call) => {
      log('media-call: incoming from', call.peer, '- answering with', (state.localStream ? state.localStream.getTracks().map((t) => t.kind).join('+') || 'no-tracks' : 'no-stream'));
      ensureMember(call.peer, (call.metadata && call.metadata.name));
      call.answer(state.localStream || new MediaStream());
      setupCall(call);
    });

    peer.on('disconnected', () => {
      state.connected = false; saveStatus();
      if (state.inParty) { try { peer.reconnect(); } catch (e) {} }
    });

    peer.on('close', () => {
      // Peer destroyed (fatal). The watchdog will rebuild it while in a party.
      state.connected = false; saveStatus();
    });

    peer.on('error', (err) => {
      const type = err && err.type;
      log('peer error', type, err && err.message);
      if (type === 'unavailable-id') {
        // Our host id is still held by a previous (now-dead) tab. Wait for the
        // broker to free it, then re-register. Keep trying - the watchdog backs us up.
        if (state.isHost && state.inParty) {
          state._idRetries = (state._idRetries || 0) + 1;
          setTimeout(() => { if (state.inParty && !state.connected) reinitPeer(); }, 2000);
        }
      } else if (type === 'peer-unavailable') {
        // Host not registered right now (flaky broker / host reloading). Do NOT
        // give up - the watchdog keeps retrying until the host is reachable.
        if (!hostDataOpen()) {
          state._hostRetries = (state._hostRetries || 0) + 1;
          if (state._hostRetries === 1) toast('Waiting for the host to come online…');
          setTimeout(() => { if (state.inParty && !hostDataOpen()) connectData(state.hostId); }, 2500);
        }
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(type)) {
        // Lost the broker socket. Reconnect (keeps live P2P channels); only
        // fully rebuild if the peer was destroyed.
        if (state.inParty) setTimeout(() => {
          if (!state.inParty || state.connected) return;
          const p = state.peer;
          if (!p || p.destroyed) reinitPeer();
          else { try { p.reconnect(); } catch (e) { reinitPeer(); } }
        }, 2500);
      }
    });
  }

  // Rebuild the broker connection (keeps our peer id) after a fatal drop.
  function reinitPeer() {
    try { if (state.peer) state.peer.destroy(); } catch (e) {}
    state.peer = null;
    initPeer();
  }

  // Self-healing: keep the host registered and keep joiners reaching the host,
  // so a flaky free-cloud broker doesn't permanently break the connection.
  function startWatchdog() {
    stopWatchdog();
    state.watchdogTimer = setInterval(() => {
      if (!state.inParty) return;
      const p = state.peer;
      if (!p || p.destroyed) { log('watchdog: peer gone -> reinit'); reinitPeer(); return; }
      if (p.disconnected) { try { p.reconnect(); } catch (e) {} return; }
      // Joiner: keep trying to reach the host until the data channel is open.
      if (!state.isHost && state.hostId && !hostDataOpen()) connectData(state.hostId);
      // Safety net: if hostId is nobody's and I'm the designated standby,
      // stand in (covers the beacon-holder itself later leaving, or a host
      // vanishing without a clean 'peer-left' broadcast, e.g. a crash).
      maybeBecomeBeacon();
      // For every connected peer without media yet, (re)try the media call.
      state.members.forEach((m, id) => {
        if (m.dataConn && m.dataConn.open && !m.stream) ensureMedia(id);
      });
    }, 5000);
  }
  function stopWatchdog() {
    if (state.watchdogTimer) { clearInterval(state.watchdogTimer); state.watchdogTimer = null; }
  }

  // ------------------------------------------------------- mesh formation -----

  function ensureMember(peerId, name) {
    if (peerId === state.peerId) return null;
    let m = state.members.get(peerId);
    if (!m) {
      m = { name: name || 'Guest', dataConn: null, call: null, stream: null, tile: null };
      state.members.set(peerId, m);
    } else if (name) {
      m.name = name;
    }
    return m;
  }

  // Lower peer id initiates, so exactly one side opens each connection.
  function iInitiateTo(peerId) { return state.peerId < peerId; }

  function hostDataOpen() {
    const m = state.members.get(state.hostId);
    return !!(m && m.dataConn && m.dataConn.open);
  }

  function connectData(peerId) {
    if (peerId === state.peerId || !state.peer) return;
    const m = ensureMember(peerId);
    if (m.dataConn && m.dataConn.open) return;                    // already connected
    if (m._connecting && Date.now() - m._connecting < 4500) return; // attempt in flight
    m._connecting = Date.now();
    try { if (m.dataConn) m.dataConn.close(); } catch (e) {}       // drop a stale/failed conn
    log('data-conn -> connecting to', peerId);
    const conn = state.peer.connect(peerId, {
      reliable: true, metadata: { name: state.name },
    });
    setupDataConn(conn, /*incoming*/ false);
  }

  function ensureData(peerId) {
    const m = ensureMember(peerId);
    if (!m || m.dataConn) return;
    if (iInitiateTo(peerId)) connectData(peerId);
    // else: wait for them to connect to us
  }

  function ensureMedia(peerId) {
    const m = ensureMember(peerId);
    if (!m) return;
    if (m.stream) return;                                  // media already flowing
    // A call was placed but no stream arrived - it stalled. Tear it down and retry.
    if (m.call && m._callStart && Date.now() - m._callStart > 9000) {
      try { m.call.close(); } catch (e) {}
      m.call = null;
    }
    if (m.call) return;                                    // attempt in flight
    if (iInitiateTo(peerId)) {
      m._callStart = Date.now();
      log('media-call -> calling', peerId, 'with', (state.localStream ? state.localStream.getTracks().map((t) => t.kind).join('+') || 'no-tracks' : 'no-stream'));
      const call = state.peer.call(peerId, state.localStream || new MediaStream(), {
        metadata: { name: state.name },
      });
      setupCall(call);
    } else {
      log('media-call: waiting for', peerId, 'to call me');
    }
  }

  function attachIceLog(pc, label) {
    if (!pc || pc.__couchIce) return;
    pc.__couchIce = true;
    pc.addEventListener('iceconnectionstatechange', () => log('ice[' + label + ']', pc.iceConnectionState));
    pc.addEventListener('icecandidateerror', (e) => log('ice-cand-error[' + label + ']', e && (e.errorCode + ' ' + e.url)));
  }

  function setupDataConn(conn, incoming) {
    const peerId = conn.peer;
    const m = ensureMember(peerId, conn.metadata && conn.metadata.name);
    m.dataConn = conn;

    log('data-conn', incoming ? 'incoming from' : 'outgoing to', peerId);
    // PeerJS creates the RTCPeerConnection during negotiation - hook ICE once it exists.
    setTimeout(() => attachIceLog(conn.peerConnection, 'data'), 300);
    conn.on('open', () => {
      m._connecting = 0;
      state._hostRetries = 0;
      log('data-conn OPEN with', peerId);
      conn.send({ t: 'hello', name: state.name });
      ensureMedia(peerId);

      // Joined via a beacon (no real host to ask): the first real member
      // connection to actually open gets asked for the current position.
      if (state.needSyncRequest) { state.needSyncRequest = false; sendTo(peerId, { t: 'sync-request' }); }

      if (state.isHost && incoming) {
        // A newcomer reached the host. Introduce everyone.
        conn.send({ t: 'welcome', members: membersListExcluding(peerId) });
        broadcastExcept(peerId, { t: 'peer-joined', peerId, name: m.name });
        // Put the newcomer on the same title we're watching.
        if (state.videoId) conn.send({ t: 'title', videoId: state.videoId });
      }
      render(); saveStatus();
    });

    conn.on('data', (msg) => handleData(peerId, msg));

    conn.on('close', () => { log('data-conn CLOSED with', peerId); dropMember(peerId, /*announce*/ state.isHost); });
    conn.on('error', (e) => { log('data-conn ERROR with', peerId, e && e.type); dropMember(peerId, /*announce*/ state.isHost); });
  }

  function handleData(fromId, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello':
        ensureMember(fromId, msg.name); render(); saveStatus();
        break;
      case 'welcome':
        // From the host (or a standby beacon - see "host resilience"): connect
        // to every other existing member.
        (msg.members || []).forEach((p) => {
          ensureMember(p.peerId, p.name);
          ensureData(p.peerId);
          ensureMedia(p.peerId);
        });
        if (msg.beacon) {
          // The sender is just a temporary "front door", not a real
          // participant - it never carries media, so don't try to call it.
          // Ask the first real member whose connection actually opens for the
          // current position instead (see setupDataConn's open handler).
          state.needSyncRequest = true;
        } else {
          ensureMedia(fromId); // also bring up media with the host
          sendTo(fromId, { t: 'sync-request' });
        }
        render();
        break;
      case 'peer-joined':
        ensureMember(msg.peerId, msg.name);
        ensureData(msg.peerId);
        ensureMedia(msg.peerId);
        toast(`${msg.name} joined`);
        render();
        break;
      case 'peer-left':
        dropMember(msg.peerId, false);
        break;
      case 'sync':
        applyRemoteSync(msg);
        break;
      case 'ad':
        if (msg.inAd) state.peersInAd.add(fromId);
        else state.peersInAd.delete(fromId);
        reconcileAdHold(msg.timeMs);
        break;
      case 'drift':
        applyDriftCorrection(msg);
        break;
      case 'sync-request':
        sendToPage({ type: 'request-state' });
        break;
      case 'chat':
        addChatMessage(state.members.get(fromId)?.name || msg.name || 'Guest',
                       msg.text, /*self*/ false);
        break;
      case 'title':
        followTitle(msg.videoId);
        break;
    }
  }

  function setupCall(call) {
    const peerId = call.peer;
    const m = ensureMember(peerId, call.metadata && call.metadata.name);
    m.call = call;
    call.on('stream', (stream) => {
      log('media stream from', peerId, stream.getTracks().map((t) => t.kind).join('+'));
      m.stream = stream;
      m._callStart = 0;
      renderPeerTile(peerId, m);
    });
    call.on('close', () => { m.call = null; });
    call.on('error', (e) => { log('call error', peerId, e); m.call = null; });

    // Watch ICE so we can log failures and retry once via TURN.
    const pc = call.peerConnection;
    if (pc) {
      pc.addEventListener('iceconnectionstatechange', () => {
        log('ice', peerId, pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed') {
          try { pc.restartIce && pc.restartIce(); } catch (e) {}
        }
      });
    }
  }

  function dropMember(peerId, announce) {
    const m = state.members.get(peerId);
    if (!m) return;
    try { if (m.call) m.call.close(); } catch (e) {}
    try { if (m.dataConn) m.dataConn.close(); } catch (e) {}
    if (m.tile) m.tile.remove();
    state.members.delete(peerId);
    // Forget any ad they were in. Otherwise someone who closes the tab mid-ad
    // leaves the rest of the party held forever waiting for a break that ended
    // when they left.
    if (state.peersInAd.delete(peerId)) reconcileAdHold();
    if (announce) broadcast({ t: 'peer-left', peerId });
    // If the peer we just lost WAS the room's front door, the room becomes
    // unjoinable for anyone new (existing members stay meshed to each other
    // fine). See "host resilience" below.
    if (peerId === state.hostId) maybeBecomeBeacon();
    render(); saveStatus();
  }

  // ------------------------------------------------ host resilience (beacon) --
  //
  // New joiners only ever know how to find the room's fixed hostId - that's
  // the sole discovery mechanism. If the person who created the party (the
  // literal occupant of hostId) leaves, existing members stay connected to
  // each other (the mesh survives), but nobody NEW can get in: hostId is
  // vacant and every join attempt just times out.
  //
  // Fix: once the real host is gone, the surviving member with the
  // lexicographically-lowest peer ID opens a second, minimal Peer registered
  // AT hostId - a "beacon". Its only job is to answer a newcomer's connection
  // with the current member list (exactly like the host's own welcome reply)
  // so the newcomer meshes in with everyone's REAL peer IDs, then it steps
  // back. It never joins the call/data mesh under the hostId identity, so it
  // doesn't touch the already-live, working connections at all.
  //
  // If two members briefly both think they're "the lowest" (race), only one
  // can actually register hostId - the broker enforces that uniqueness, so
  // the loser just backs off. No coordination messages needed for that part.

  function isDesignatedStandby() {
    const candidates = [state.peerId, ...state.members.keys()];
    return candidates.reduce((a, b) => (a < b ? a : b)) === state.peerId;
  }

  function maybeBecomeBeacon() {
    if (!state.inParty || state.isHost) return;   // the real host doesn't need one
    if (state.beaconPeer) return;                 // already running one
    if (hostDataOpen()) return;                   // a real host (or beacon) is already here
    if (!isDesignatedStandby()) return;            // someone else should do it
    // Cheap cooldown: a member who joined via a beacon has that connection
    // deliberately closed ~1s later (see startBeacon), so hostDataOpen() reads
    // "nobody home" for them almost immediately even while an existing beacon
    // is healthy elsewhere. Rather than track "was that a real host or a
    // beacon" precisely, just bound retry frequency - a failed attempt (the
    // broker rejects a second registration of the same id) is harmless.
    if (state._lastBeaconAttempt && Date.now() - state._lastBeaconAttempt < 15000) return;
    state._lastBeaconAttempt = Date.now();
    startBeacon();
  }

  async function startBeacon() {
    log('beacon: attempting to stand in for the host at', state.hostId);
    // The beacon<->joiner data connection still needs real STUN/TURN (same as
    // any other connection) - it's just a normal peer connection whose only
    // job happens to be relaying one 'welcome' message.
    const iceServers = await buildIceServers();
    if (!state.inParty || state.isHost || state.beaconPeer || hostDataOpen()) return; // stale by the time creds arrived
    const bp = new Peer(state.hostId, peerOptions(iceServers));
    state.beaconPeer = bp;

    bp.on('open', () => log('beacon: standing in as', state.hostId));

    bp.on('connection', (conn) => {
      conn.on('open', () => {
        log('beacon: greeting new joiner', conn.peer);
        // Include our OWN real identity (not this throwaway hostId one) as a
        // normal member, so the newcomer meshes with us the regular way too.
        const members = [...membersListExcluding(null), { peerId: state.peerId, name: state.name }];
        conn.send({ t: 'welcome', members, beacon: true });
        if (state.videoId) conn.send({ t: 'title', videoId: state.videoId });
        // Job done for this newcomer - don't linger as a fake mesh member.
        setTimeout(() => { try { conn.close(); } catch (e) {} }, 1000);
      });
    });

    const giveUp = () => {
      try { bp.destroy(); } catch (e) {}
      if (state.beaconPeer === bp) state.beaconPeer = null;
    };
    bp.on('error', (err) => {
      log('beacon error (standing down):', err && err.type);
      giveUp(); // e.g. unavailable-id: someone else already has it, or the real host is back
    });
    bp.on('disconnected', giveUp);
    bp.on('close', giveUp);
  }

  function stopBeacon() {
    if (state.beaconPeer) { try { state.beaconPeer.destroy(); } catch (e) {} state.beaconPeer = null; }
  }

  // ----------------------------------------------------------- messaging ------

  function sendTo(peerId, obj) {
    const m = state.members.get(peerId);
    if (m && m.dataConn && m.dataConn.open) m.dataConn.send(obj);
  }
  function broadcast(obj) {
    state.members.forEach((m) => { if (m.dataConn && m.dataConn.open) m.dataConn.send(obj); });
  }
  function broadcastExcept(exceptId, obj) {
    state.members.forEach((m, id) => {
      if (id !== exceptId && m.dataConn && m.dataConn.open) m.dataConn.send(obj);
    });
  }

  function applyRemoteSync(msg) {
    state.lastAppliedAt = Date.now();
    sendToPage({
      type: 'command',
      cmd: { action: msg.action === 'sync' ? (msg.paused ? 'pause' : 'play') : msg.action,
             timeMs: msg.timeMs },
    });
  }

  // ---------------------------------------------------------- same title ------

  // The host announces which title to watch; everyone else follows by opening
  // it (the party auto-reconnects after the navigation via couchActive).
  function broadcastTitle() {
    if (state.videoId) broadcast({ t: 'title', videoId: state.videoId });
  }

  function followTitle(videoId) {
    if (!videoId || state.isHost) return;            // host is the source of truth
    if (currentVideoId() === videoId) return;        // already on it
    toast('Opening the host’s title…');
    persistActive();
    location.href = watchUrl(videoId, state.room);
  }

  // Track the title from the URL. The host broadcasts when it changes so late
  // joiners and title switches keep everyone on the same show.
  function startTitlePoll() {
    stopTitlePoll();
    let ticks = 0;
    const tick = () => {
      const vid = currentVideoId();
      if (vid && vid !== state.videoId) {
        state.videoId = vid;
        if (state.isHost) broadcastTitle();
        saveStatus();
      }
      // Heartbeat the active-party timestamp so a refresh/navigation while the
      // party is live reconnects, but a visit much later does not.
      if (++ticks % 8 === 0) persistActive();
    };
    tick();
    state.titlePollTimer = setInterval(tick, 2000);
  }
  function stopTitlePoll() {
    if (state.titlePollTimer) { clearInterval(state.titlePollTimer); state.titlePollTimer = null; }
  }

  // ------------------------------------------------------------ local media ---

  const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

  async function ensureLocalStream() {
    if (state.localStream) return state.localStream;
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({
        audio: AUDIO_CONSTRAINTS,
        video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 24 } },
      });
      log('getUserMedia OK:', state.localStream.getTracks().map((t) => t.kind).join('+') || 'no-tracks');
    } catch (e) {
      log('getUserMedia (audio+video) FAILED:', e && e.name, '-', e && e.message);
      // Camera might be missing/busy while the mic is fine - don't lose working
      // audio just because video failed. Retry audio-only before giving up.
      try {
        state.localStream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
        log('getUserMedia OK (audio-only fallback)');
        toast('Camera unavailable - joining with audio only');
      } catch (e2) {
        log('getUserMedia (audio-only) FAILED:', e2 && e2.name, '-', e2 && e2.message, '(joining listen-only)');
        const reason = (e2 && e2.name === 'NotAllowedError') ? 'permission denied'
          : (e2 && e2.name === 'NotReadableError') ? 'device already in use'
          : (e2 && e2.name === 'NotFoundError') ? 'no camera/mic found' : 'unavailable';
        toast(`Mic/camera ${reason} - joining in listen-only mode`);
        state.localStream = new MediaStream();
      }
    }
    applyTrackToggles();
    renderLocalTile();
    return state.localStream;
  }

  function applyTrackToggles() {
    if (!state.localStream) return;
    state.localStream.getAudioTracks().forEach((t) => (t.enabled = state.micOn));
    state.localStream.getVideoTracks().forEach((t) => (t.enabled = state.camOn));
  }

  // ------------------------------------------------------------ overlay UI ----

  let ui = null;

  // Persisted overlay geometry: size, floating position, and pin state.
  const GEO_KEY = 'couchOverlay';
  const overlayGeo = { w: null, h: null, left: null, top: null, pin: 'none' };
  let applyingGeo = false;
  let geoSaveTimer = null;

  function loadGeo(cb) {
    try {
      chrome.storage.local.get([GEO_KEY], (r) => {
        if (r && r[GEO_KEY]) Object.assign(overlayGeo, r[GEO_KEY]);
        cb && cb();
      });
    } catch (e) { cb && cb(); }
  }
  function saveGeo() {
    clearTimeout(geoSaveTimer);
    geoSaveTimer = setTimeout(() => {
      try { chrome.storage.local.set({ [GEO_KEY]: overlayGeo }); } catch (e) {}
    }, 300);
  }

  // When docked, push the Netflix page into the remaining space so the panel
  // never overlaps the video. We scale <body> (our overlay lives on <html>, a
  // sibling of <body>, so it isn't affected) - robust to any Netflix layout.
  function applyPagePush() {
    const b = document.body;
    if (!b) return;
    const de = document.documentElement;
    if (!state.inParty || overlayGeo.pin === 'none') {
      b.style.transform = '';
      b.style.transformOrigin = '';
      b.style.transition = '';
      de.classList.remove('couch-pinned');
      return;
    }
    const w = overlayGeo.w || (ui ? ui.offsetWidth : 280);
    const vw = window.innerWidth || 1;
    const s = Math.max(0.2, (vw - w) / vw);
    de.classList.add('couch-pinned');           // black backdrop behind scaled page
    b.style.transition = 'transform 0.12s ease';
    b.style.transformOrigin = overlayGeo.pin === 'right' ? 'top left' : 'top right';
    b.style.transform = `scale(${s})`;
  }

  function applyGeo(root) {
    applyingGeo = true;
    root.classList.remove('lv-pin-left', 'lv-pin-right');
    root.style.width = overlayGeo.w ? overlayGeo.w + 'px' : '';
    if (overlayGeo.pin === 'right' || overlayGeo.pin === 'left') {
      root.classList.add(overlayGeo.pin === 'right' ? 'lv-pin-right' : 'lv-pin-left');
      root.style.left = ''; root.style.top = ''; root.style.right = ''; root.style.height = '';
    } else {
      root.style.height = overlayGeo.h ? overlayGeo.h + 'px' : '';
      if (overlayGeo.left != null) {
        root.style.left = overlayGeo.left + 'px';
        root.style.top = (overlayGeo.top || 0) + 'px';
        root.style.right = 'auto';
      }
    }
    updatePinBtn(root);
    applyPagePush();
    requestAnimationFrame(() => { applyingGeo = false; });
  }

  function updatePinBtn(root) {
    const btn = root.querySelector('.lv-pin');
    if (!btn) return;
    btn.classList.toggle('lv-active', overlayGeo.pin !== 'none');
    btn.title = overlayGeo.pin === 'none' ? 'Pin to right edge'
      : overlayGeo.pin === 'right' ? 'Pinned right - click to pin left'
      : 'Pinned left - click to unpin (float)';
  }

  function cyclePin(root) {
    overlayGeo.pin = overlayGeo.pin === 'none' ? 'right'
      : overlayGeo.pin === 'right' ? 'left' : 'none';
    applyGeo(root);
    saveGeo();
  }

  function buildOverlay() {
    if (ui) return ui;
    const root = document.createElement('div');
    root.id = 'couch-overlay';
    root.innerHTML = `
      <div class="lv-header">
        <span class="lv-logo">Couch</span>
        <span class="lv-room"></span>
        <button class="lv-diagtoggle" title="Connection diagnostics">🩺</button>
        <button class="lv-chattoggle" title="Show / hide chat">💬<span class="lv-unread"></span></button>
        <button class="lv-pin" title="Pin to side">📌</button>
        <button class="lv-collapse" title="Collapse">–</button>
      </div>
      <div class="lv-tiles"></div>
      <div class="lv-chat">
        <div class="lv-chatlog"></div>
        <form class="lv-chatform">
          <input class="lv-chatinput" type="text" placeholder="Type a message…" maxlength="500" autocomplete="off" />
          <button class="lv-chatsend" type="submit" title="Send">➤</button>
        </form>
      </div>
      <div class="lv-diag">
        <div class="lv-diag-bar">
          <span class="lv-diag-title">Diagnostics</span>
          <button class="lv-diag-copy" type="button">Copy report</button>
        </div>
        <pre class="lv-diag-body"></pre>
      </div>
      <div class="lv-controls">
        <button class="lv-btn lv-mic"   title="Mute / unmute">🎤</button>
        <button class="lv-btn lv-cam"   title="Camera on / off">📷</button>
        <button class="lv-btn lv-sync"  title="Resync everyone to my position">⟳</button>
        <button class="lv-btn lv-copy"  title="Copy invite link">⧉</button>
        <button class="lv-btn lv-leave" title="Leave party">⏻</button>
      </div>
      <div class="lv-status"></div>
      <div class="lv-resizer" title="Drag to resize width"></div>
      <div class="lv-grip" title="Drag to resize"></div>`;
    document.documentElement.appendChild(root);

    root.querySelector('.lv-collapse').onclick = () => root.classList.toggle('lv-collapsed');
    root.querySelector('.lv-chattoggle').onclick = () => toggleChat(root);
    root.querySelector('.lv-pin').onclick = () => cyclePin(root);
    root.querySelector('.lv-mic').onclick = toggleMic;
    root.querySelector('.lv-cam').onclick = toggleCam;
    root.querySelector('.lv-sync').onclick = forceResync;
    root.querySelector('.lv-copy').onclick = () => {
      const link = inviteLink();
      const text = link || state.room;
      navigator.clipboard.writeText(text).then(() =>
        toast(link ? 'Invite link copied - opens this show & joins' : 'Invite code copied'));
    };
    root.querySelector('.lv-leave').onclick = leaveParty;
    root.querySelector('.lv-diagtoggle').onclick = () => toggleDiag(root);
    root.querySelector('.lv-diag-copy').onclick = () => {
      navigator.clipboard.writeText(diagText()).then(() => toast('Diagnostics copied - paste it to share'));
    };
    setupChat(root);

    makeDraggable(root, root.querySelector('.lv-header'));
    makeEdgeResizer(root, root.querySelector('.lv-resizer'));    // docked: width
    makeCornerResizer(root, root.querySelector('.lv-grip'));     // floating: w + h

    // Keep the docked panel pushing the page if the browser window is resized.
    window.addEventListener('resize', () => { if (overlayGeo.pin !== 'none') applyPagePush(); });

    ui = root;
    loadGeo(() => applyGeo(root));
    installFullscreenHook();
    // Re-fit the tile grid whenever the panel changes size (drag-resize,
    // dock/undock, window resize) so tiles always use the space they can get.
    try { new ResizeObserver(() => layoutTiles()).observe(root); } catch (e) {}
    return root;
  }

  // The native Fullscreen API only paints the fullscreen element and its
  // DOM descendants - everything else (including our overlay, normally a
  // sibling under <html>) is hidden regardless of z-index. So when Netflix
  // (or the user) goes fullscreen, re-parent the overlay INTO the fullscreen
  // element for the duration, then move it back on exit.
  let fullscreenHookInstalled = false;
  const overlayHome = { parent: null, next: null }; // where to restore it to
  function currentFullscreenEl() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }
  function handleFullscreenChange() {
    if (!ui) return;
    const fsEl = currentFullscreenEl();
    if (fsEl) {
      if (ui.parentNode !== fsEl) {
        overlayHome.parent = ui.parentNode;
        overlayHome.next = ui.nextSibling;
        fsEl.appendChild(ui);
      }
    } else if (overlayHome.parent) {
      overlayHome.parent.insertBefore(ui, overlayHome.next);
      overlayHome.parent = null; overlayHome.next = null;
    }
  }
  function installFullscreenHook() {
    if (fullscreenHookInstalled) return;
    fullscreenHookInstalled = true;
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
  }

  // Visible bottom-corner grip - resizes the floating panel in both dimensions.
  function makeCornerResizer(el, grip) {
    let sx = 0, sy = 0, sw = 0, sh = 0, resizing = false;
    grip.addEventListener('mousedown', (e) => {
      if (overlayGeo.pin !== 'none') return; // docked uses the edge handle
      resizing = true;
      sx = e.clientX; sy = e.clientY; sw = el.offsetWidth; sh = el.offsetHeight;
      e.preventDefault(); e.stopPropagation();
    });
    window.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const w = Math.max(200, Math.min(window.innerWidth * 0.7, sw + (e.clientX - sx)));
      const h = Math.max(170, Math.min(window.innerHeight * 0.95, sh + (e.clientY - sy)));
      el.style.width = w + 'px';
      el.style.height = h + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing = false;
      overlayGeo.w = el.offsetWidth;
      overlayGeo.h = el.offsetHeight;
      saveGeo();
    });
  }

  function makeDraggable(el, handle) {
    let dx = 0, dy = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      // Dragging a docked panel detaches it back into a floating window.
      if (overlayGeo.pin !== 'none') {
        const r = el.getBoundingClientRect();
        overlayGeo.pin = 'none';
        overlayGeo.left = r.left; overlayGeo.top = r.top;
        overlayGeo.w = r.width; overlayGeo.h = r.height;
        applyGeo(el);
      }
      dragging = true;
      dx = e.clientX - el.offsetLeft;
      dy = e.clientY - el.offsetTop;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = Math.max(0, e.clientX - dx) + 'px';
      el.style.top = Math.max(0, e.clientY - dy) + 'px';
      el.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      overlayGeo.left = el.offsetLeft;
      overlayGeo.top = el.offsetTop;
      overlayGeo.pin = 'none';
      saveGeo();
    });
  }

  // Width handle on the inner edge, used while the panel is docked to a side.
  function makeEdgeResizer(el, grip) {
    let startX = 0, startW = 0, resizing = false;
    grip.addEventListener('mousedown', (e) => {
      if (overlayGeo.pin === 'none') return; // floating uses the CSS corner grip
      resizing = true;
      startX = e.clientX;
      startW = el.offsetWidth;
      e.preventDefault();
      e.stopPropagation();
    });
    window.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const delta = overlayGeo.pin === 'right' ? startX - e.clientX : e.clientX - startX;
      const w = Math.max(200, Math.min(window.innerWidth * 0.7, startW + delta));
      el.style.width = w + 'px';
      overlayGeo.w = w;
      applyPagePush(); // reflow the video live as the dock width changes
    });
    window.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing = false;
      overlayGeo.w = el.offsetWidth;
      saveGeo();
    });
  }

  function renderLocalTile() {
    const root = buildOverlay();
    const tiles = root.querySelector('.lv-tiles');
    let tile = tiles.querySelector('.lv-tile-local');
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'lv-tile lv-tile-local';
      tile.innerHTML = `<video autoplay playsinline muted></video><span class="lv-name">You</span>`;
      tiles.prepend(tile);
      layoutTiles();
    }
    const v = tile.querySelector('video');
    if (state.localStream && v.srcObject !== state.localStream) {
      v.srcObject = state.localStream;
      playMedia(v, false);   // local tile is always muted anyway
    }
    tile.classList.toggle('lv-camoff', !state.camOn);
  }

  function renderPeerTile(peerId, m) {
    const root = buildOverlay();
    const tiles = root.querySelector('.lv-tiles');
    if (!m.tile) {
      m.tile = document.createElement('div');
      m.tile.className = 'lv-tile lv-connecting';
      // Start muted so the video autoplays without a click; unmute on gesture.
      m.tile.innerHTML = `<video autoplay playsinline muted></video><span class="lv-name"></span>`;
      tiles.appendChild(m.tile);
      layoutTiles();
    }
    m.tile.querySelector('.lv-name').textContent = m.name || 'Guest';
    // They are connected once the data channel is open, even before media lands.
    if (m.dataConn && m.dataConn.open) m.tile.classList.remove('lv-connecting');
    const v = m.tile.querySelector('video');
    if (m.stream && v.srcObject !== m.stream) {
      v.srcObject = m.stream;
      m.tile.classList.remove('lv-connecting');
      playMedia(v, true);
    }
  }

  // Size tiles like Meet/Zoom: pick the column count that lets tiles use as
  // much of the available area (panel width x the tiles strip's height
  // budget) as possible at their natural 4:3 shape, without distorting or
  // pushing the chat/controls out. CSS alone can't express "fit BOTH width
  // and height for n items", so this computes it and sets the grid columns.
  function layoutTiles() {
    if (!ui) return;
    const tilesEl = ui.querySelector('.lv-tiles');
    if (!tilesEl) return;
    const n = tilesEl.children.length;
    if (!n) return;
    const GAP = 6, PAD = 16, AR = 4 / 3;
    const W = Math.max(100, tilesEl.clientWidth - PAD);
    // The tiles strip may use up to ~55% of the panel (matches the CSS cap).
    const H = Math.max(80, ui.clientHeight * 0.55 - PAD);
    let bestW = 110, bestCols = Math.min(n, 2);
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const byWidth = (W - (cols - 1) * GAP) / cols;
      const byHeight = ((H - (rows - 1) * GAP) / rows) * AR;
      const w = Math.min(byWidth, byHeight);
      if (w > bestW) { bestW = w; bestCols = cols; }
    }
    // Exact column count (not auto-fit) so the chosen arrangement is kept -
    // auto-fit would happily pack extra columns when they fit, breaking e.g.
    // an intended 2x2 into 3+1.
    tilesEl.style.gridTemplateColumns =
      `repeat(${bestCols}, ${Math.floor(bestW)}px)`;
  }

  function render() {
    const root = buildOverlay();
    root.querySelector('.lv-room').textContent = state.room ? `#${state.room}` : '';
    const n = state.members.size + 1;
    root.querySelector('.lv-status').textContent =
      `${state.connected ? '🟢' : '🔴'} ${n} watching`;
    root.querySelector('.lv-mic').classList.toggle('lv-off', !state.micOn);
    root.querySelector('.lv-cam').classList.toggle('lv-off', !state.camOn);
    renderLocalTile();
    state.members.forEach((m, id) => renderPeerTile(id, m));
    layoutTiles();
  }

  let toastTimer = null;
  function toast(text) {
    const root = buildOverlay();
    let t = root.querySelector('.lv-toast');
    if (!t) { t = document.createElement('div'); t.className = 'lv-toast'; root.appendChild(t); }
    t.textContent = text;
    t.classList.add('lv-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('lv-show'), 2500);
  }

  // -------------------------------------------------------------- chat --------

  let unread = 0;

  function setupChat(root) {
    const form = root.querySelector('.lv-chatform');
    const input = root.querySelector('.lv-chatinput');
    form.addEventListener('submit', (e) => { e.preventDefault(); sendChat(); });
    // Keep keystrokes (space, f, etc.) from triggering Netflix shortcuts.
    ['keydown', 'keyup', 'keypress'].forEach((ev) =>
      input.addEventListener(ev, (e) => e.stopPropagation()));
    input.addEventListener('focus', () => clearUnread());
  }

  function sendChat() {
    const input = ui && ui.querySelector('.lv-chatinput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (state.inParty) broadcast({ t: 'chat', text, name: state.name });
    addChatMessage(state.name, text, /*self*/ true);
  }

  function addChatMessage(name, text, self) {
    if (!text) return;
    const root = buildOverlay();
    const logEl = root.querySelector('.lv-chatlog');
    const row = document.createElement('div');
    row.className = 'lv-msg' + (self ? ' lv-msg-self' : '');
    const who = document.createElement('span');
    who.className = 'lv-msg-from';
    who.textContent = self ? 'You' : name;
    const body = document.createElement('span');
    body.className = 'lv-msg-text';
    body.textContent = text;                 // textContent => safe, no HTML injection
    row.appendChild(who);
    row.appendChild(body);
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
    if (!self && root.classList.contains('lv-chathidden')) {
      unread++; updateUnread(root);
    }
  }

  function toggleChat(root) {
    root.classList.toggle('lv-chathidden');
    if (!root.classList.contains('lv-chathidden')) {
      clearUnread();
      const input = root.querySelector('.lv-chatinput');
      if (input) input.focus();
      const logEl = root.querySelector('.lv-chatlog');
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function clearUnread() { unread = 0; if (ui) updateUnread(ui); }
  function updateUnread(root) {
    const badge = root.querySelector('.lv-unread');
    if (!badge) return;
    badge.textContent = unread > 0 ? (unread > 9 ? '9+' : String(unread)) : '';
    badge.classList.toggle('lv-show', unread > 0);
  }

  // -------------------------------------------------------- diagnostics -------

  function version() {
    try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; }
  }

  // A full human-readable status + event report the user can copy to us.
  function diagText() {
    const L = [];
    const p = state.peer;
    L.push('=== Couch diagnostics ===');
    L.push('version : ' + version());
    L.push('site    : ' + location.hostname + '  (' + platform().label + ', watch=' + onWatchPage() + ')');
    L.push('role    : ' + (state.isHost ? 'HOST' : 'joiner') + '   inParty=' + state.inParty);
    L.push('me      : ' + state.peerId);
    L.push('room    : ' + state.room + '   hostId=' + state.hostId);
    L.push('broker  : ' + (state.brokerHost || 'peerjs-cloud') + '   connected=' + state.connected +
           '   peerDestroyed=' + (p ? !!p.destroyed : 'n/a') + '   peerDisconnected=' + (p ? !!p.disconnected : 'n/a'));
    const ls = state.localStream
      ? (state.localStream.getTracks().map((t) => t.kind + (t.enabled ? '' : ':off')).join('+') || 'no-tracks')
      : 'none';
    L.push('myMedia : ' + ls + '   mic=' + state.micOn + ' cam=' + state.camOn);
    L.push('beacon  : ' + (state.beaconPeer ? 'standing in for the host (' + (state.beaconPeer.open ? 'open' : 'connecting') + ')' : 'no - not needed right now'));
    L.push('peers   : ' + state.members.size);
    state.members.forEach((m, id) => {
      const dice = (m.dataConn && m.dataConn.peerConnection) ? m.dataConn.peerConnection.iceConnectionState : '-';
      const ice = (m.call && m.call.peerConnection) ? m.call.peerConnection.iceConnectionState : '-';
      const conn = (m.call && m.call.peerConnection) ? m.call.peerConnection.connectionState : '-';
      const stream = m.stream ? (m.stream.getTracks().map((t) => t.kind).join('+') || 'empty') : 'none';
      L.push('  - ' + (m.name || '?') + '  ' + id);
      L.push('      data=' + (m.dataConn ? (m.dataConn.open ? 'OPEN' : 'pending') : 'none') +
             '  dataIce=' + dice + '  call=' + (m.call ? 'yes' : 'no') + '  mediaIce=' + ice + '  pc=' + conn + '  stream=' + stream);
    });
    L.push('--- event log (newest last) ---');
    diagLog.slice(-140).forEach((e) => L.push(fmtT(e.t) + '  ' + e.line));
    return L.join('\n');
  }

  let diagTimer = null;
  function toggleDiag(root) {
    root.classList.toggle('lv-diag-open');
    const open = root.classList.contains('lv-diag-open');
    if (diagTimer) { clearInterval(diagTimer); diagTimer = null; }
    if (open) { refreshDiag(); diagTimer = setInterval(refreshDiag, 1500); }
  }
  function refreshDiag() {
    if (!ui || !ui.classList.contains('lv-diag-open')) return;
    const body = ui.querySelector('.lv-diag-body');
    if (!body) return;
    const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
    body.textContent = diagText();
    if (atBottom) body.scrollTop = body.scrollHeight;
  }

  // ------------------------------------------------------------ controls ------

  function toggleMic() { state.micOn = !state.micOn; applyTrackToggles(); render(); saveStatus(); }
  function toggleCam() { state.camOn = !state.camOn; applyTrackToggles(); render(); saveStatus(); }
  function forceResync() { sendToPage({ type: 'request-state' }); toast('Resyncing everyone…'); }

  // ------------------------------------------------------- party lifecycle ----

  async function startParty({ room, name, brokerHost, host }) {
    state.room = (room || randomId()).toUpperCase();
    state.name = name || state.name || 'Guest';
    state.brokerHost = brokerHost || DEFAULT_BROKER;
    state.isHost = !!host;
    state.hostId = hostIdFor(state.room);
    // Host owns the rendezvous id; joiners get a unique random id.
    state.peerId = host ? state.hostId : 'couch-' + randomId(10);
    state.inParty = true;
    state.videoId = currentVideoId();
    await ensureLocalStream();
    await initPeer();
    startTitlePoll();
    startWatchdog();
    startDriftBeat();
    persistActive();
    render(); saveStatus();
    return { room: state.room };
  }

  function leaveParty() {
    state.inParty = false;
    broadcast({ t: 'peer-left', peerId: state.peerId });
    [...state.members.keys()].forEach((id) => dropMember(id, false));
    try { if (state.peer) state.peer.destroy(); } catch (e) {}
    state.peer = null; state.connected = false;
    stopBeacon();
    stopTitlePoll();
    stopWatchdog();
    stopDriftBeat();
    state.peersInAd.clear();
    state.selfInAd = false;
    state.heldForAd = false;
    state.videoId = null;
    if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
    applyPagePush();                 // reset any docked page transform first
    if (ui) { ui.remove(); ui = null; }
    overlayHome.parent = null; overlayHome.next = null;
    state.room = null; state.hostId = null;
    try { chrome.storage.local.set({ couchActive: null }); } catch (e) {}
    saveStatus();
  }

  // --------------------------------------------------- popup <-> content ------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.type) {
        case 'get-status':
          sendResponse({
            present: true, watch: onWatchPage(),
            inParty: state.inParty, connected: state.connected, room: state.room,
            name: state.name, micOn: state.micOn, camOn: state.camOn, members: memberStatus(),
            link: inviteLink(), videoId: state.videoId, platform: platform().label,
          });
          break;
        case 'create-party':
          sendResponse(await startParty({ room: randomId(), name: msg.name,
            brokerHost: msg.brokerHost, host: true }));
          break;
        case 'join-party':
          sendResponse(await startParty({ room: msg.room, name: msg.name,
            brokerHost: msg.brokerHost, host: false }));
          break;
        case 'leave-party': leaveParty(); sendResponse({ ok: true }); break;
        case 'toggle-mic': toggleMic(); sendResponse({ micOn: state.micOn }); break;
        case 'toggle-cam': toggleCam(); sendResponse({ camOn: state.camOn }); break;
        default: sendResponse({});
      }
    })();
    return true;
  });

  // ----------------------------------------------------------- bootstrap ------

  chrome.storage.local.get(['couchBrokerHost', 'couchName', 'couchActive'], (cfg) => {
    if (cfg.couchBrokerHost) state.brokerHost = cfg.couchBrokerHost;
    if (cfg.couchName) state.name = cfg.couchName;
    if (state.inParty) return;

    // Room from the invite link: accept ?couch=CODE or #couch=CODE (some sites
    // drop query params on navigation, so the hash is a fallback).
    const linkRoomRaw = new URLSearchParams(location.search).get('couch') ||
      (location.hash.match(/couch=([A-Za-z0-9]+)/) || [])[1] || null;
    const linkRoom = linkRoomRaw ? linkRoomRaw.toUpperCase() : null;
    const active = cfg.couchActive;
    const fresh = active && active.room && active.ts && (Date.now() - active.ts) < 10 * 60 * 1000;

    // An explicit invite link ALWAYS wins over a saved session. This prevents a
    // recent/stale party (from testing) from hijacking a fresh invite link and
    // silently reconnecting you to the wrong (or dead) room.
    if (linkRoom && (!active || String(active.room).toUpperCase() !== linkRoom)) {
      log('auto-join from invite link', linkRoom);
      try { chrome.storage.local.set({ couchActive: null }); } catch (e) {}
      startParty({ room: linkRoom, name: state.name, brokerHost: state.brokerHost, host: false });
    } else if (fresh) {
      // Auto-reconnect after a navigation (host's title-follow, refresh, etc.).
      log('auto-reconnect to party', active.room, active.isHost ? '(host)' : '(guest)');
      startParty({ room: active.room, name: active.name || state.name,
        brokerHost: active.brokerHost || state.brokerHost, host: active.isHost });
    } else if (linkRoom) {
      // Link matches our saved session (or no session): join it.
      log('auto-join from invite link (matches session)', linkRoom);
      startParty({ room: linkRoom, name: state.name, brokerHost: state.brokerHost, host: false });
    } else if (active && active.room) {
      // Stale active party → forget it.
      try { chrome.storage.local.set({ couchActive: null }); } catch (e) {}
    }
  });

  // Console diagnostics: run `__couchDebug()` in the page console any time.
  window.__couchDebug = function () {
    const rows = [...state.members.entries()].map(([id, m]) => ({
      peer: id, name: m.name,
      data: m.dataConn ? (m.dataConn.open ? 'open' : 'pending') : 'none',
      call: m.call ? 'yes' : 'no',
      ice: m.call && m.call.peerConnection ? m.call.peerConnection.iceConnectionState : '-',
      stream: m.stream ? m.stream.getTracks().map((t) => t.kind).join('+') : 'none',
    }));
    console.log('[Couch] me=%s host=%s inParty=%s', state.peerId, state.isHost, state.inParty);
    console.table(rows);
    console.log('[Couch] localStream tracks:',
      state.localStream ? state.localStream.getTracks().map((t) => t.kind + ':' + t.readyState) : 'none');
    return rows;
  };

  log('content script ready on', location.href);
})();
