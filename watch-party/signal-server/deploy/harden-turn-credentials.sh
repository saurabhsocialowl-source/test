#!/usr/bin/env bash
#
# Upgrade an already-running Couch signal-server + coturn from a permanent,
# baked-in TURN password to short-lived, per-session credentials (the
# standard coturn "REST API" convention: expiring username + HMAC-SHA1
# credential, minted on demand by GET /turn-creds).
#
# Why: the extension's source (including any static TURN password) is public
# once published to the Chrome Web Store or committed to GitHub - a fixed
# password baked into it can be extracted and used by anyone to relay their
# own unrelated traffic through your TURN server. Short-lived credentials
# close that off: the extension fetches a fresh, time-limited credential each
# time it needs one, and the secret that mints them never leaves the server.
#
# Prereqs: coturn and the Couch signal-server are already installed (i.e. you
# already ran setup-turn-hetzner.sh and setup-hetzner.sh once). Safe to re-run.
#
# Usage (as root):
#   bash harden-turn-credentials.sh [domain] [secret]
# domain defaults to signal.vermasaurabh.com; secret is generated if omitted
# (re-running with no secret argument keeps reusing the one already in place,
# read back from turnserver.conf, so it won't invalidate itself pointlessly).
#
set -euo pipefail

DOMAIN="${1:-signal.vermasaurabh.com}"
DIR="/opt/couch/watch-party/signal-server"
REALM="vermasaurabh.com"

# Reuse the existing secret on a re-run instead of silently rotating it (that
# would just be pointless churn); only generate a new one the first time.
EXISTING="$(grep -oP '^static-auth-secret=\K.*' /etc/turnserver.conf 2>/dev/null || true)"
SECRET="${2:-${EXISTING:-$(openssl rand -hex 32)}}"

echo "==> 1/5 Reconfiguring coturn for use-auth-secret"
if [ ! -f /etc/turnserver.conf ]; then
  echo "No /etc/turnserver.conf found - run setup-turn-hetzner.sh first."; exit 1
fi
IP="$(grep -oP '^external-ip=\K.*' /etc/turnserver.conf || curl -fsS -4 https://api.ipify.org)"
cat > /etc/turnserver.conf <<EOF
# Couch TURN relay (coturn) - short-lived REST-style credentials
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=$SECRET
realm=$REALM
external-ip=$IP
min-port=49152
max-port=65535
no-tls
no-dtls
no-cli
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
EOF
systemctl restart coturn
sleep 1
systemctl is-active --quiet coturn || { echo "coturn failed to restart - check: journalctl -u coturn -n 50"; exit 1; }

echo "==> 2/5 Pulling latest signal-server code"
git -C /opt/couch fetch origin claude/watch-party-browser-plugin-i6i4zb
git -C /opt/couch checkout claude/watch-party-browser-plugin-i6i4zb
git -C /opt/couch pull --ff-only origin claude/watch-party-browser-plugin-i6i4zb
cd "$DIR" && npm install --omit=dev

echo "==> 3/5 Restarting the signal server with TURN_SECRET set"
if command -v pm2 >/dev/null 2>&1; then
  HOST=127.0.0.1 PORT=9000 CREDS_PORT=9001 TURN_SECRET="$SECRET" pm2 restart couch-signal --update-env
  pm2 save
else
  echo "PM2 not found - set HOST/PORT/CREDS_PORT/TURN_SECRET in your service manager and restart couch-signal manually."
fi

echo "==> 4/5 Re-applying nginx config (adds the /turn-creds route)"
CONF="/etc/nginx/sites-available/couch-signal"
sed "s/signal.example.com/$DOMAIN/g" "$DIR/deploy/nginx-couch-signal.conf" > "$CONF"
ln -sf "$CONF" /etc/nginx/sites-enabled/couch-signal
nginx -t && systemctl reload nginx

echo "==> 5/5 Verifying"
sleep 1
RESP="$(curl -fsS "https://$DOMAIN/turn-creds" || true)"
if echo "$RESP" | grep -q '"credential"'; then
  echo ""
  echo "SUCCESS. Short-lived TURN credentials are live at https://$DOMAIN/turn-creds"
  echo "The extension will pick this up automatically (it already checks this"
  echo "endpoint first and only falls back to the static credential if it's"
  echo "unreachable)."
  echo "Tell Claude: turn-creds hardening is live."
else
  echo "Did not get a credential back ($RESP). Check:"
  echo "  curl http://127.0.0.1:9001/turn-creds   (bypassing nginx)"
  echo "  pm2 logs couch-signal"
  exit 1
fi
