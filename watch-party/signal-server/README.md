# Couch signaling server

A dedicated PeerJS broker so Couch stops depending on the free public cloud
(`0.peerjs.com`), which rate-limits and drops connections. This is the reliability
fix for "worked once, then could not connect".

It only relays WebRTC connection-setup messages (peer ids + SDP/ICE). It never
sees your audio, video, chat, playback, or any streaming content.

> **Why this matters:** every participant must use the **same** broker. Once you
> deploy this and set it as the default in the extension (one line), all installs
> connect through your reliable broker automatically.

---

## Option A - your own Linux server (Hetzner etc.) - most reliable

Prereqs: Node 18+, nginx, a subdomain (e.g. `signal.example.com`) pointing at the box.

```bash
# 1. Get the code onto the server
sudo mkdir -p /opt/couch && cd /opt/couch
git clone https://github.com/saurabhsocialowl-source/test.git .
cd watch-party/signal-server
npm install --omit=dev

# 2. Run it as a service (listens on 127.0.0.1:9000)
sudo cp deploy/couch-signal.service /etc/systemd/system/
#   edit WorkingDirectory/User inside the unit if your paths differ
sudo systemctl daemon-reload && sudo systemctl enable --now couch-signal
sudo systemctl status couch-signal      # should be active (running)

# 3. TLS + WebSocket proxy via nginx
sudo certbot --nginx -d signal.example.com      # or reuse an existing cert
sudo cp deploy/nginx-couch-signal.conf /etc/nginx/sites-available/couch-signal
sudo ln -s /etc/nginx/sites-available/couch-signal /etc/nginx/sites-enabled/
#   edit server_name + ssl_certificate paths to your subdomain
sudo nginx -t && sudo systemctl reload nginx
```

Verify:
```bash
curl https://signal.example.com/peerjs/id      # -> a random UUID = broker is live
```

## Option B - Docker (any container host)

```bash
cd watch-party/signal-server
docker build -t couch-signal .
docker run -d --restart=always -p 9000:9000 --name couch-signal couch-signal
# then put nginx/Caddy in front for TLS, or run behind your platform's TLS
```

## Option C - Render / Railway / Fly

- New **Web Service** from this repo, root dir `watch-party/signal-server`.
- Build: `npm install`  Start: `npm start`  (health check path `/peerjs/id`).
- Use the platform's provided `https://...` domain.
- Note: Render's **free** tier sleeps after 15 min (cold starts hurt signaling) -
  use a paid instance or Option A for something that is always on.

---

## Point the extension at your broker

Two ways (they can be combined):

1. **Bake it as the default for everyone (recommended).** In
   `extension/src/content.js` set:
   ```js
   const DEFAULT_BROKER = 'signal.example.com';
   ```
   Rebuild (`./build.sh`) and ship. Every install now uses your broker - no
   per-user setup, and everyone is guaranteed to share the same one.

2. **Per-user override.** In the extension popup: Advanced -> Signaling broker ->
   enter `signal.example.com`. (Everyone in a party must enter the same value.)

The extension connects over **wss on port 443** using PeerJS defaults
(path `/`, key `peerjs`), which is exactly what this server serves.

---

## Hardening: short-lived TURN credentials

By default the extension ships with a **static** TURN username/password. That's
fine to get started, but since the extension's source is public (Chrome Web
Store listings and this repo can both be inspected), a fixed password baked
into it could be extracted and used by anyone to relay unrelated traffic
through your TURN server.

This server can instead mint **short-lived, per-session credentials** on
demand (`GET /turn-creds`), following coturn's standard "REST API" convention
(an expiring username + an HMAC-SHA1 credential). The secret used to sign
them never leaves the server - it's not in the extension at all. The
extension always tries this endpoint first and only falls back to the static
credential if it's unreachable (e.g. an older, not-yet-upgraded server), so
upgrading is a zero-downtime, non-breaking change.

To turn it on (after `setup-hetzner.sh` and `setup-turn-hetzner.sh` have
already been run once):

```bash
sudo bash deploy/harden-turn-credentials.sh signal.example.com
```

This reconfigures coturn for `use-auth-secret` mode, restarts the signal
server with the matching `TURN_SECRET`, and adds the `/turn-creds` nginx
route. Verify:

```bash
curl https://signal.example.com/turn-creds
# -> {"username":"<expiry-timestamp>:couch","credential":"...","ttl":21600}
```

The default TTL is 6 hours (long enough to cover a full watch-party session
without needing credentials to be refreshed mid-call); override with the
`TURN_TTL_SECONDS` env var if you want something different.
