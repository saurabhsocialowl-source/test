/*
 * Livance — content script (isolated world) running on netflix.com/watch/*.
 *
 * Responsibilities:
 *   1. Inject injected.js to control the real Netflix player.
 *   2. Maintain the WebSocket connection to the Livance signaling/sync server.
 *   3. Synchronize play/pause/seek both ways (everyone shares controls).
 *   4. Run a WebRTC mesh for the group audio/video call.
 *   5. Render the in-page overlay UI.
 *
 * The Netflix tab stays open for the whole party, so this script (not the
 * service worker) owns all long-lived state.
 */
(function () {
  'use strict';

  if (window.__livanceContent) return;
  window.__livanceContent = true;

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  const state = {
    serverUrl: 'ws://localhost:8080',
    ws: null,
    connected: false,
    room: null,
    peerId: null,
    name: 'Guest',
    inParty: false,
    micOn: true,
    camOn: true,
    localStream: null,
    peers: new Map(), // peerId -> { name, pc, stream, tile }
    reconnectTimer: null,
    lastAppliedAt: 0,
  };

  // ------------------------------------------------------------------ utils ---

  const log = (...a) => console.debug('%c[Livance]', 'color:#0FB5A3', ...a);

  function randomId(n = 8) {
    const c = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
  }

  function saveStatus() {
    const status = {
      inParty: state.inParty,
      connected: state.connected,
      room: state.room,
      name: state.name,
      micOn: state.micOn,
      camOn: state.camOn,
      members: [state.name, ...[...state.peers.values()].map((p) => p.name)],
    };
    try {
      chrome.storage.local.set({ livanceStatus: status });
      chrome.runtime.sendMessage({ type: 'status', status }).catch(() => {});
    } catch (e) {}
  }

  // --------------------------------------------------------- page bridge ------

  function injectPageScript() {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('src/injected.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }

  function sendToPage(msg) {
    window.postMessage(Object.assign({ source: 'livance-content' }, msg), '*');
  }

  // Local playback events bubbling up from the page -> broadcast to peers.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== 'livance-page') return;

    if (d.type === 'state' && state.inParty && state.connected) {
      // Don't rebroadcast a state we just applied from someone else.
      if (Date.now() - state.lastAppliedAt < 400) return;
      send({
        type: 'sync',
        action: d.action,
        paused: d.paused,
        timeMs: d.timeMs,
      });
    }
  });

  // ----------------------------------------------------------- signaling ------

  function send(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(obj));
    }
  }

  function connect() {
    if (state.ws && (state.ws.readyState === WebSocket.OPEN ||
                     state.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    log('connecting to', state.serverUrl);
    let ws;
    try {
      ws = new WebSocket(state.serverUrl);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    state.ws = ws;

    ws.onopen = () => {
      state.connected = true;
      clearTimeout(state.reconnectTimer);
      send({ type: 'join', room: state.room, peerId: state.peerId, name: state.name });
      toast('Connected to party server');
      saveStatus();
    };

    ws.onclose = () => {
      state.connected = false;
      saveStatus();
      if (state.inParty) scheduleReconnect();
    };

    ws.onerror = () => { try { ws.close(); } catch (e) {} };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleServerMessage(msg);
    };
  }

  function scheduleReconnect() {
    if (!state.inParty) return;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(connect, 2000);
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'peers':
        // Existing members already in the room when we joined.
        (msg.peers || []).forEach((p) => ensurePeer(p.peerId, p.name, /*initiate*/ true));
        // Ask the room for authoritative playback position so we line up.
        send({ type: 'sync-request' });
        render();
        break;

      case 'peer-joined':
        // A newcomer arrives; the lower peerId initiates to avoid glare.
        ensurePeer(msg.peerId, msg.name, state.peerId < msg.peerId);
        toast(`${msg.name} joined`);
        render();
        break;

      case 'peer-left':
        removePeer(msg.peerId);
        toast(`${(state.peers.get(msg.peerId) || {}).name || 'Someone'} left`);
        render();
        break;

      case 'signal':
        handleSignal(msg);
        break;

      case 'sync':
        applyRemoteSync(msg);
        break;

      case 'sync-request':
        // Someone wants the current position; answer with ours.
        sendToPage({ type: 'request-state' });
        break;
    }
  }

  // ------------------------------------------------------------- sync ---------

  function applyRemoteSync(msg) {
    state.lastAppliedAt = Date.now();
    sendToPage({
      type: 'command',
      cmd: { action: msg.action === 'sync' ? (msg.paused ? 'pause' : 'play') : msg.action,
             timeMs: msg.timeMs },
    });
  }

  // ------------------------------------------------------------ WebRTC --------

  async function ensureLocalStream() {
    if (state.localStream) return state.localStream;
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: 320, height: 240 },
      });
    } catch (e) {
      toast('Mic/camera blocked — joining in listen-only mode');
      // Empty stream so the call still works for the others.
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

  function ensurePeer(peerId, name, initiate) {
    if (peerId === state.peerId) return;
    let peer = state.peers.get(peerId);
    if (!peer) {
      peer = { name: name || 'Guest', pc: null, stream: null, tile: null };
      state.peers.set(peerId, peer);
    } else {
      peer.name = name || peer.name;
    }
    if (!peer.pc) createPeerConnection(peerId, peer, initiate);
    saveStatus();
    return peer;
  }

  async function createPeerConnection(peerId, peer, initiate) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peer.pc = pc;

    const stream = await ensureLocalStream();
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        send({ type: 'signal', to: peerId, from: state.peerId,
               payload: { candidate: e.candidate } });
      }
    };

    pc.ontrack = (e) => {
      peer.stream = e.streams[0];
      renderPeerTile(peerId, peer);
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        // Try to recover by tearing the tile; server presence drives rejoin.
        renderPeerTile(peerId, peer);
      }
    };

    if (initiate) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: 'signal', to: peerId, from: state.peerId,
               payload: { sdp: pc.localDescription } });
      } catch (e) { log('offer error', e); }
    }
  }

  async function handleSignal(msg) {
    const from = msg.from;
    let peer = state.peers.get(from);
    if (!peer) peer = ensurePeer(from, msg.name, false);
    const pc = peer.pc || (await (createPeerConnection(from, peer, false), peer.pc));

    const payload = msg.payload || {};
    try {
      if (payload.sdp) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        if (payload.sdp.type === 'offer') {
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          send({ type: 'signal', to: from, from: state.peerId,
                 payload: { sdp: peer.pc.localDescription } });
        }
      } else if (payload.candidate) {
        await peer.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
      }
    } catch (e) { log('signal error', e); }
  }

  function removePeer(peerId) {
    const peer = state.peers.get(peerId);
    if (!peer) return;
    try { if (peer.pc) peer.pc.close(); } catch (e) {}
    if (peer.tile) peer.tile.remove();
    state.peers.delete(peerId);
    saveStatus();
  }

  // ------------------------------------------------------------ overlay UI ----

  let ui = null;

  function buildOverlay() {
    if (ui) return ui;
    const root = document.createElement('div');
    root.id = 'livance-overlay';
    root.innerHTML = `
      <div class="lv-header">
        <span class="lv-logo">Livance</span>
        <span class="lv-room"></span>
        <button class="lv-collapse" title="Collapse">–</button>
      </div>
      <div class="lv-tiles"></div>
      <div class="lv-controls">
        <button class="lv-btn lv-mic"   title="Mute / unmute">🎤</button>
        <button class="lv-btn lv-cam"   title="Camera on / off">📷</button>
        <button class="lv-btn lv-sync"  title="Resync everyone to my position">⟳</button>
        <button class="lv-btn lv-copy"  title="Copy invite code">⧉</button>
        <button class="lv-btn lv-leave" title="Leave party">⏻</button>
      </div>
      <div class="lv-status"></div>`;
    document.documentElement.appendChild(root);

    root.querySelector('.lv-collapse').onclick = () => root.classList.toggle('lv-collapsed');
    root.querySelector('.lv-mic').onclick = toggleMic;
    root.querySelector('.lv-cam').onclick = toggleCam;
    root.querySelector('.lv-sync').onclick = forceResync;
    root.querySelector('.lv-copy').onclick = () => {
      navigator.clipboard.writeText(state.room).then(() => toast('Invite code copied'));
    };
    root.querySelector('.lv-leave').onclick = leaveParty;

    makeDraggable(root, root.querySelector('.lv-header'));
    ui = root;
    return root;
  }

  function makeDraggable(el, handle) {
    let dx = 0, dy = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
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
    window.addEventListener('mouseup', () => (dragging = false));
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
    if (state.localStream && v.srcObject !== state.localStream) v.srcObject = state.localStream;
    tile.classList.toggle('lv-camoff', !state.camOn);
  }

  function renderPeerTile(peerId, peer) {
    const root = buildOverlay();
    const tiles = root.querySelector('.lv-tiles');
    if (!peer.tile) {
      peer.tile = document.createElement('div');
      peer.tile.className = 'lv-tile';
      peer.tile.innerHTML = `<video autoplay playsinline></video><span class="lv-name"></span>`;
      tiles.appendChild(peer.tile);
    }
    peer.tile.querySelector('.lv-name').textContent = peer.name;
    const v = peer.tile.querySelector('video');
    if (peer.stream && v.srcObject !== peer.stream) v.srcObject = peer.stream;
  }

  function render() {
    const root = buildOverlay();
    root.querySelector('.lv-room').textContent = state.room ? `#${state.room}` : '';
    const n = state.peers.size + 1;
    root.querySelector('.lv-status').textContent =
      `${state.connected ? '🟢' : '🔴'} ${n} watching`;
    root.querySelector('.lv-mic').classList.toggle('lv-off', !state.micOn);
    root.querySelector('.lv-cam').classList.toggle('lv-off', !state.camOn);
    renderLocalTile();
    state.peers.forEach((peer, id) => renderPeerTile(id, peer));
  }

  let toastTimer = null;
  function toast(text) {
    const root = buildOverlay();
    let t = root.querySelector('.lv-toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'lv-toast';
      root.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('lv-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('lv-show'), 2500);
  }

  // ------------------------------------------------------------ controls ------

  function toggleMic() { state.micOn = !state.micOn; applyTrackToggles(); render(); saveStatus(); }
  function toggleCam() { state.camOn = !state.camOn; applyTrackToggles(); render(); saveStatus(); }
  function forceResync() { sendToPage({ type: 'request-state' }); toast('Resyncing everyone…'); }

  // ------------------------------------------------------- party lifecycle ----

  async function joinParty({ room, name, serverUrl }) {
    state.room = (room || randomId()).toUpperCase();
    state.name = name || state.name || 'Guest';
    state.peerId = state.peerId || randomId(12);
    if (serverUrl) state.serverUrl = serverUrl;
    state.inParty = true;
    await ensureLocalStream();
    connect();
    render();
    saveStatus();
    return { room: state.room };
  }

  function leaveParty() {
    state.inParty = false;
    send({ type: 'leave', room: state.room, peerId: state.peerId });
    [...state.peers.keys()].forEach(removePeer);
    try { if (state.ws) state.ws.close(); } catch (e) {}
    if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
    if (ui) { ui.remove(); ui = null; }
    state.room = null;
    saveStatus();
  }

  // --------------------------------------------------- popup <-> content ------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg.type) {
        case 'get-status':
          sendResponse({
            inParty: state.inParty, connected: state.connected, room: state.room,
            name: state.name, micOn: state.micOn, camOn: state.camOn,
            members: [state.name, ...[...state.peers.values()].map((p) => p.name)],
          });
          break;
        case 'create-party': {
          const r = await joinParty({ room: randomId(), name: msg.name, serverUrl: msg.serverUrl });
          sendResponse(r);
          break;
        }
        case 'join-party': {
          const r = await joinParty({ room: msg.room, name: msg.name, serverUrl: msg.serverUrl });
          sendResponse(r);
          break;
        }
        case 'leave-party':
          leaveParty();
          sendResponse({ ok: true });
          break;
        case 'toggle-mic': toggleMic(); sendResponse({ micOn: state.micOn }); break;
        case 'toggle-cam': toggleCam(); sendResponse({ camOn: state.camOn }); break;
        default: sendResponse({});
      }
    })();
    return true; // async response
  });

  // ----------------------------------------------------------- bootstrap ------

  chrome.storage.local.get(['livanceServerUrl', 'livanceName'], (cfg) => {
    if (cfg.livanceServerUrl) state.serverUrl = cfg.livanceServerUrl;
    if (cfg.livanceName) state.name = cfg.livanceName;
  });

  injectPageScript();
  log('content script ready on', location.href);
})();
