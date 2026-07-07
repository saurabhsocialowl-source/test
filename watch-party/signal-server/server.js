/*
 * Couch signaling server - a dedicated PeerJS broker so the extension no longer
 * depends on the rate-limited free public cloud (0.peerjs.com).
 *
 * It only relays WebRTC connection-setup messages (peer ids + SDP/ICE). It never
 * sees your audio, video, chat, playback, or any streaming content - those flow
 * directly between participants.
 *
 * A second, tiny HTTP server mints short-lived TURN credentials (GET
 * /turn-creds) using the standard coturn "REST API" convention (time-limited
 * username + HMAC-SHA1 credential), so the extension never ships a permanent,
 * extractable TURN password. Requires TURN_SECRET here to match coturn's
 * static-auth-secret (see deploy/setup-turn-hetzner.sh). It runs on its own
 * port so it doesn't have to fight the `peer` package for control of the main
 * HTTP server - nginx routes /turn-creds to it (see deploy/nginx-couch-signal.conf).
 *
 * Run:   npm install && npm start
 * Env:   PORT (default 9000), PATH_PREFIX (default "/"), KEY (default "couch"),
 *        HOST (default "0.0.0.0"), CREDS_PORT (default 9001),
 *        TURN_SECRET (shared with coturn's static-auth-secret; if unset,
 *        /turn-creds is disabled and the extension falls back to its
 *        built-in static credentials - functional but less hardened),
 *        TURN_TTL_SECONDS (default 21600 = 6h, long enough for a full watch session)
 *
 * Behind TLS (nginx/Caddy) terminate https/wss and proxy to this port.
 * Health / liveness:  GET <PATH_PREFIX>/<KEY>/id   (defaults: GET /peerjs/id)
 *                     -> returns a random peer id when the broker is up.
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const { PeerServer } = require('peer');

const PORT = Number(process.env.PORT || 9000);
const HOST = process.env.HOST || '0.0.0.0';       // IPv4 by default (avoids IPv6-only bind)
const PATH_PREFIX = process.env.PATH_PREFIX || '/';
const KEY = process.env.KEY || 'couch';
const CREDS_PORT = Number(process.env.CREDS_PORT || 9001);
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_TTL = Number(process.env.TURN_TTL_SECONDS || 21600); // 6h - long-lived P2P session, not a short call setup

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

// ---- short-lived TURN credential minting (separate small server) ----------

const credsServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (!req.url || !req.url.startsWith('/turn-creds')) {
    res.writeHead(404).end(JSON.stringify({ error: 'not found' }));
    return;
  }
  if (!TURN_SECRET) {
    res.writeHead(503).end(JSON.stringify({ error: 'turn-creds not configured' }));
    return;
  }
  // Standard coturn REST convention: username is the expiry unix timestamp
  // (optionally suffixed), credential is base64(HMAC-SHA1(secret, username)).
  // coturn (with use-auth-secret + the same static-auth-secret) validates
  // this without any server-side session/state.
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL;
  const username = String(expiry) + ':couch';
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  res.writeHead(200).end(JSON.stringify({ username, credential, ttl: TURN_TTL }));
});

credsServer.listen(CREDS_PORT, HOST, () => {
  console.log(`TURN credential endpoint on ${HOST}:${CREDS_PORT} (${TURN_SECRET ? 'enabled' : 'DISABLED - no TURN_SECRET set, extension will use its static fallback'})`);
});
