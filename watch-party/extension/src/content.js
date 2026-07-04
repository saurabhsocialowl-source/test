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

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // Free TURN relays so media still connects through strict/symmetric NATs.
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  // Remote <video> elements carry audio, so browsers block autoplay until the
  // page sees a user gesture. We try to play immediately and, if blocked, queue
  // the element and resume them all on the first click/keypress on the page.
  const pendingMedia = new Set();
  let gestureHookInstalled = false;
  function playMedia(v) {
    const p = v.play();
    if (p && p.catch) {
      p.catch(() => {
        pendingMedia.add(v);
        installGestureHook();
      });
    }
  }
  function installGestureHook() {
    if (gestureHookInstalled) return;
    gestureHookInstalled = true;
    toast('Click anywhere to enable party audio/video');
    const resume = () => {
      pendingMedia.forEach((v) => { v.play().catch(() => {}); });
      pendingMedia.clear();
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
  };

  // ------------------------------------------------------------------ utils ---

  const log = (...a) => console.debug('%c[Couch]', 'color:#0FB5A3', ...a);

  function randomId(n = 8) {
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
  });

  // ------------------------------------------------------- PeerJS plumbing ----

  function peerOptions() {
    const opts = { debug: 1, config: { iceServers: ICE_SERVERS } };
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

  function initPeer() {
    const peer = new Peer(state.peerId, peerOptions());
    state.peer = peer;

    peer.on('open', (id) => {
      state.peerId = id;
      state.connected = true;
      log('broker open as', id, state.isHost ? '(host)' : '(joiner)');
      if (!state.isHost) connectData(state.hostId); // bootstrap discovery
      toast(state.isHost ? 'Party ready - share the code' : 'Joined - connecting…');
      render(); saveStatus();
    });

    peer.on('connection', (conn) => setupDataConn(conn, /*incoming*/ true));

    peer.on('call', (call) => {
      ensureMember(call.peer, (call.metadata && call.metadata.name));
      call.answer(state.localStream || new MediaStream());
      setupCall(call);
    });

    peer.on('disconnected', () => {
      state.connected = false; saveStatus();
      if (state.inParty) { try { peer.reconnect(); } catch (e) {} }
    });

    peer.on('error', (err) => {
      log('peer error', err && err.type, err && err.message);
      if (err && err.type === 'unavailable-id') {
        // Host id still held by our previous (now-dead) tab after a refresh.
        // Wait for the broker to free it, then re-register.
        if (state.isHost && state.inParty && (state._idRetries = (state._idRetries || 0) + 1) <= 6) {
          setTimeout(() => { try { if (state.peer) state.peer.destroy(); } catch (e) {} initPeer(); }, 1800);
        } else {
          toast('That code is taken - try creating again');
        }
      } else if (err && err.type === 'peer-unavailable') {
        // Host not ready yet (e.g. both navigated at once) - retry a few times.
        if (hostDataOpen()) return;               // already connected; ignore
        if (!state.isHost && state.inParty &&
            (state._hostRetries = (state._hostRetries || 0) + 1) <= 8) {
          setTimeout(() => { if (!hostDataOpen()) connectData(state.hostId); }, 1800);
        } else {
          // Give up cleanly so the next attempt starts fresh (no stale session).
          toast('Could not reach the host. Make sure their party is open, then rejoin.');
          try { chrome.storage.local.set({ couchActive: null }); } catch (e) {}
          leaveParty();
        }
      } else if (err && err.type === 'network') {
        toast('Signaling network hiccup - retrying…');
      }
    });
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
    if (peerId === state.peerId) return;
    const m = ensureMember(peerId);
    if (m.dataConn) return;
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
    if (!m || m.call) return;
    if (iInitiateTo(peerId)) {
      const call = state.peer.call(peerId, state.localStream || new MediaStream(), {
        metadata: { name: state.name },
      });
      setupCall(call);
    }
    // else: wait for their incoming call
  }

  function setupDataConn(conn, incoming) {
    const peerId = conn.peer;
    const m = ensureMember(peerId, conn.metadata && conn.metadata.name);
    m.dataConn = conn;

    conn.on('open', () => {
      conn.send({ t: 'hello', name: state.name });
      ensureMedia(peerId);

      if (state.isHost && incoming) {
        // A newcomer reached the host. Introduce everyone.
        const others = [...state.members.entries()]
          .filter(([id]) => id !== peerId)
          .map(([id, mm]) => ({ peerId: id, name: mm.name }));
        conn.send({ t: 'welcome', members: others });
        broadcastExcept(peerId, { t: 'peer-joined', peerId, name: m.name });
        // Put the newcomer on the same title we're watching.
        if (state.videoId) conn.send({ t: 'title', videoId: state.videoId });
      }
      render(); saveStatus();
    });

    conn.on('data', (msg) => handleData(peerId, msg));

    conn.on('close', () => dropMember(peerId, /*announce*/ state.isHost));
    conn.on('error', () => dropMember(peerId, /*announce*/ state.isHost));
  }

  function handleData(fromId, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello':
        ensureMember(fromId, msg.name); render(); saveStatus();
        break;
      case 'welcome':
        // From the host: connect to every other existing member.
        (msg.members || []).forEach((p) => {
          ensureMember(p.peerId, p.name);
          ensureData(p.peerId);
          ensureMedia(p.peerId);
        });
        ensureMedia(fromId); // also bring up media with the host
        sendTo(fromId, { t: 'sync-request' });
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
    if (announce) broadcast({ t: 'peer-left', peerId });
    render(); saveStatus();
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

  async function ensureLocalStream() {
    if (state.localStream) return state.localStream;
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 24 } },
      });
    } catch (e) {
      log('getUserMedia failed:', e && e.name, e && e.message);
      toast('Mic/camera unavailable - joining in listen-only mode');
      state.localStream = new MediaStream();
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
      <div class="lv-controls">
        <button class="lv-btn lv-mic"   title="Mute / unmute">🎤</button>
        <button class="lv-btn lv-cam"   title="Camera on / off">📷</button>
        <button class="lv-btn lv-sync"  title="Resync everyone to my position">⟳</button>
        <button class="lv-btn lv-copy"  title="Copy invite code">⧉</button>
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
    setupChat(root);

    makeDraggable(root, root.querySelector('.lv-header'));
    makeEdgeResizer(root, root.querySelector('.lv-resizer'));    // docked: width
    makeCornerResizer(root, root.querySelector('.lv-grip'));     // floating: w + h

    // Keep the docked panel pushing the page if the browser window is resized.
    window.addEventListener('resize', () => { if (overlayGeo.pin !== 'none') applyPagePush(); });

    ui = root;
    loadGeo(() => applyGeo(root));
    return root;
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
    }
    const v = tile.querySelector('video');
    if (state.localStream && v.srcObject !== state.localStream) {
      v.srcObject = state.localStream;
      playMedia(v);
    }
    tile.classList.toggle('lv-camoff', !state.camOn);
  }

  function renderPeerTile(peerId, m) {
    const root = buildOverlay();
    const tiles = root.querySelector('.lv-tiles');
    if (!m.tile) {
      m.tile = document.createElement('div');
      m.tile.className = 'lv-tile lv-connecting';
      m.tile.innerHTML = `<video autoplay playsinline></video><span class="lv-name"></span>`;
      tiles.appendChild(m.tile);
    }
    m.tile.querySelector('.lv-name').textContent = m.name;
    const v = m.tile.querySelector('video');
    if (m.stream && v.srcObject !== m.stream) {
      v.srcObject = m.stream;
      m.tile.classList.remove('lv-connecting');
      playMedia(v);
    }
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

  // ------------------------------------------------------------ controls ------

  function toggleMic() { state.micOn = !state.micOn; applyTrackToggles(); render(); saveStatus(); }
  function toggleCam() { state.camOn = !state.camOn; applyTrackToggles(); render(); saveStatus(); }
  function forceResync() { sendToPage({ type: 'request-state' }); toast('Resyncing everyone…'); }

  // ------------------------------------------------------- party lifecycle ----

  async function startParty({ room, name, brokerHost, host }) {
    state.room = (room || randomId()).toUpperCase();
    state.name = name || state.name || 'Guest';
    state.brokerHost = brokerHost || '';
    state.isHost = !!host;
    state.hostId = hostIdFor(state.room);
    // Host owns the rendezvous id; joiners get a unique random id.
    state.peerId = host ? state.hostId : 'couch-' + randomId(10);
    state.inParty = true;
    state.videoId = currentVideoId();
    await ensureLocalStream();
    initPeer();
    startTitlePoll();
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
    stopTitlePoll();
    state.videoId = null;
    if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
    applyPagePush();                 // reset any docked page transform first
    if (ui) { ui.remove(); ui = null; }
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
