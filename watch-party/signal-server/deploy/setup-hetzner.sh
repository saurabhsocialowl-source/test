#!/usr/bin/env bash
#
# One-shot Couch signaling-server setup for an Ubuntu box with nginx + certbot
# (+ PM2 if present). Idempotent - safe to re-run to update.
#
# Prereq you must do first: add a DNS A record for the subdomain pointing at
# this server, set to "DNS only" (grey cloud) in Cloudflare.
#
# Usage (as root):
#   bash setup-hetzner.sh signal.vermasaurabh.com you@email.com
#
set -euo pipefail

DOMAIN="${1:?Usage: setup-hetzner.sh <domain> [email]}"
EMAIL="${2:-saurabhsocialowl@gmail.com}"
REPO="https://github.com/saurabhsocialowl-source/test.git"
BRANCH="claude/watch-party-browser-plugin-i6i4zb"
DIR="/opt/couch"
PORT="9000"

echo "==> 1/5 Fetching code into $DIR"
mkdir -p "$DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch origin "$BRANCH" && git -C "$DIR" checkout "$BRANCH" && git -C "$DIR" pull --ff-only origin "$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR/watch-party/signal-server"
npm install --omit=dev

echo "==> 2/5 Starting the broker on 127.0.0.1:$PORT"
if command -v pm2 >/dev/null 2>&1; then
  # KEY is passed explicitly because `--update-env` replaces the environment
  # wholesale: anything omitted here is dropped and falls back to the server's
  # own default. It must stay in step with the extension (see server.js).
  HOST=127.0.0.1 PORT="$PORT" KEY="${KEY:-peerjs}" pm2 restart couch-signal --update-env 2>/dev/null \
    || HOST=127.0.0.1 PORT="$PORT" KEY="${KEY:-peerjs}" pm2 start server.js --name couch-signal
  pm2 save
else
  sed "s#/opt/couch/watch-party/signal-server#$DIR/watch-party/signal-server#; s/^Environment=HOST=.*/Environment=HOST=127.0.0.1/" \
    deploy/couch-signal.service > /etc/systemd/system/couch-signal.service
  systemctl daemon-reload && systemctl enable --now couch-signal
fi

echo "==> 3/5 Obtaining TLS certificate for $DOMAIN"
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  certbot certonly --nginx --non-interactive --agree-tos -m "$EMAIL" -d "$DOMAIN" \
    || { echo "certbot failed - is the '$DOMAIN' DNS record set to DNS-only (grey cloud) and pointing here?"; exit 1; }
else
  echo "    cert already exists, skipping"
fi

echo "==> 4/5 Installing nginx reverse proxy"
CONF="/etc/nginx/sites-available/couch-signal"
sed "s/signal.example.com/$DOMAIN/g" deploy/nginx-couch-signal.conf > "$CONF"
ln -sf "$CONF" /etc/nginx/sites-enabled/couch-signal
nginx -t
systemctl reload nginx

echo "==> 5/5 Verifying broker over HTTPS"
sleep 1
if curl -fsS "https://$DOMAIN/peerjs/id" >/dev/null; then
  echo ""
  echo "SUCCESS. Broker is live at: $DOMAIN"
  echo "Tell Claude:  broker live at $DOMAIN"
else
  echo "Broker did not answer over HTTPS yet. Check: pm2 logs couch-signal ; nginx -t ; DNS grey-cloud."
  exit 1
fi
