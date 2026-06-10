/*
 * Livance signaling + sync relay server.
 *
 * A deliberately thin WebSocket hub: it never inspects video content, it only
 * routes JSON messages between members of a room.
 *
 *   - join / leave / presence  -> room membership + peer-joined / peer-left fan-out
 *   - signal                   -> 1:1 WebRTC offer/answer/ICE forwarding
 *   - sync / sync-request      -> playback state fan-out (everyone shares controls)
 *
 * Run:  npm install && npm start         (PORT env var, default 8080)
 */
'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

/** room code -> Map(peerId -> { ws, name }) */
const rooms = new Map();

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Livance signaling server is running.');
});

const wss = new WebSocketServer({ server });

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(roomCode, obj, exceptPeerId) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const [peerId, member] of room) {
    if (peerId !== exceptPeerId) send(member.ws, obj);
  }
}

function leaveRoom(ws) {
  const { roomCode, peerId } = ws.meta || {};
  if (!roomCode || !rooms.has(roomCode)) return;
  const room = rooms.get(roomCode);
  room.delete(peerId);
  broadcast(roomCode, { type: 'peer-left', peerId });
  if (room.size === 0) rooms.delete(roomCode);
  console.log(`peer ${peerId} left #${roomCode} (${room.size} remain)`);
}

wss.on('connection', (ws) => {
  ws.meta = {};
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.type) {
      case 'join': {
        const roomCode = String(msg.room || '').toUpperCase();
        const peerId = String(msg.peerId || '');
        const name = String(msg.name || 'Guest').slice(0, 24);
        if (!roomCode || !peerId) return;

        if (!rooms.has(roomCode)) rooms.set(roomCode, new Map());
        const room = rooms.get(roomCode);

        // Tell the newcomer who is already here.
        const existing = [...room.entries()].map(([id, m]) => ({ peerId: id, name: m.name }));
        room.set(peerId, { ws, name });
        ws.meta = { roomCode, peerId, name };

        send(ws, { type: 'peers', peers: existing });
        broadcast(roomCode, { type: 'peer-joined', peerId, name }, peerId);
        console.log(`peer ${peerId} (${name}) joined #${roomCode} (${room.size} total)`);
        break;
      }

      case 'signal': {
        // 1:1 forward of WebRTC negotiation to the addressed peer.
        const { roomCode } = ws.meta;
        const room = rooms.get(roomCode);
        if (!room) return;
        const target = room.get(String(msg.to));
        if (target) {
          send(target.ws, {
            type: 'signal',
            from: ws.meta.peerId,
            name: ws.meta.name,
            payload: msg.payload,
          });
        }
        break;
      }

      case 'sync': {
        // Playback state from one member -> everyone else in the room.
        const { roomCode, peerId } = ws.meta;
        broadcast(roomCode, {
          type: 'sync',
          action: msg.action,
          paused: msg.paused,
          timeMs: msg.timeMs,
          from: peerId,
        }, peerId);
        break;
      }

      case 'sync-request': {
        // Ask the rest of the room to report their current position.
        const { roomCode, peerId } = ws.meta;
        broadcast(roomCode, { type: 'sync-request', from: peerId }, peerId);
        break;
      }

      case 'leave':
        leaveRoom(ws);
        ws.meta = {};
        break;
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

// Drop dead connections so presence stays accurate.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Livance signaling server listening on :${PORT}`);
});
