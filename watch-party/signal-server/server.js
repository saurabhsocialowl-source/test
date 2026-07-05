/*
 * Couch signaling server - a dedicated PeerJS broker so the extension no longer
 * depends on the rate-limited free public cloud (0.peerjs.com).
 *
 * It only relays WebRTC connection-setup messages (peer ids + SDP/ICE). It never
 * sees your audio, video, chat, playback, or any streaming content - those flow
 * directly between participants.
 *
 * Run:   npm install && npm start
 * Env:   PORT (default 9000), PATH_PREFIX (default "/couch"),
 *        KEY (default "couch"), HOST (default "0.0.0.0")
 *
 * Behind TLS (nginx/Caddy) terminate https/wss and proxy to this port.
 * Health / liveness:  GET <PATH_PREFIX>/<KEY>/id   (defaults: GET /peerjs/id)
 *                     -> returns a random peer id when the broker is up.
 */
'use strict';

const { PeerServer } = require('peer');

const PORT = Number(process.env.PORT || 9000);
const HOST = process.env.HOST || '0.0.0.0';       // IPv4 by default (avoids IPv6-only bind)
const PATH_PREFIX = process.env.PATH_PREFIX || '/';
const KEY = process.env.KEY || 'peerjs';

const peerServer = PeerServer({
  port: PORT,
  host: HOST,
  path: PATH_PREFIX,        // clients connect with this path
  key: KEY,
  proxied: true,            // honour X-Forwarded-* when behind nginx/Caddy
  allow_discovery: false,
  // Free host ids the instant a tab closes (the free cloud does this poorly,
  // which is why a stale host id could brick a room).
  alive_timeout: 60000,
  expire_timeout: 5000,
  concurrent_limit: 5000,
}, () => {
  console.log(`Couch signaling server listening on ${HOST}:${PORT} (path ${PATH_PREFIX}, key ${KEY})`);
});

peerServer.on('connection', (client) => {
  console.log(new Date().toISOString(), 'connect', client.getId());
});
peerServer.on('disconnect', (client) => {
  console.log(new Date().toISOString(), 'disconnect', client.getId());
});
