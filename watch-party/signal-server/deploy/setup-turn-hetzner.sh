#!/usr/bin/env bash
#
# Install + configure coturn (a TURN relay) on an Ubuntu box, so Couch peer
# connections traverse strict/symmetric NATs. Run as root.
#
# Usage:
#   bash setup-turn-hetzner.sh [turn_password]
# (password defaults to the one baked into the extension)
#
set -euo pipefail

PASSWORD="${1:-couch-turn-4Kp9x2Qm}"
REALM="vermasaurabh.com"

echo "==> Installing coturn"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y coturn

# Public IP of this server (for the relay's external-ip)
IP="$(curl -fsS -4 https://api.ipify.org 2>/dev/null || curl -fsS -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
echo "==> External IP detected: $IP"

echo "==> Writing /etc/turnserver.conf"
cat > /etc/turnserver.conf <<EOF
# Couch TURN relay (coturn)
listening-port=3478
fingerprint
lt-cred-mech
user=couch:$PASSWORD
realm=$REALM
external-ip=$IP
min-port=49152
max-port=65535
# We only need TURN over 3478 (udp+tcp); no TLS/DTLS here.
no-tls
no-dtls
no-cli
no-multicast-peers
# Do not relay to internal/private ranges (basic safety).
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
EOF

# Enable the service (Debian/Ubuntu ships it disabled by default)
if [ -f /etc/default/coturn ]; then
  sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
  grep -q '^TURNSERVER_ENABLED=1' /etc/default/coturn || echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn
else
  echo 'TURNSERVER_ENABLED=1' > /etc/default/coturn
fi

echo "==> Opening firewall (ufw), if present"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 3478/tcp || true
  ufw allow 3478/udp || true
  ufw allow 49152:65535/udp || true
fi

echo "==> Starting coturn"
systemctl enable coturn
systemctl restart coturn
sleep 1

if systemctl is-active --quiet coturn; then
  echo ""
  echo "SUCCESS. TURN relay is running on $IP:3478  (user: couch)"
  echo "IMPORTANT: also open UDP 3478 + TCP 3478 + UDP 49152-65535 in your"
  echo "Hetzner Cloud firewall (if you use one) and make sure the 'signal'"
  echo "DNS record stays 'DNS only' (grey cloud) in Cloudflare."
  echo "Tell Claude: TURN is up."
else
  echo "coturn failed to start. Check: journalctl -u coturn -n 50"
  exit 1
fi
