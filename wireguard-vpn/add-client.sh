#!/usr/bin/env bash
#
# add-client.sh — Create a new VPN client (device) config.
#
# Run this ON the VPN server, as root, AFTER install-server.sh:
#     sudo bash add-client.sh <name>
#
# Examples:
#     sudo bash add-client.sh my-phone
#     sudo bash add-client.sh work-laptop
#
# It generates a per-device keypair, assigns the next free VPN IP, registers
# the device with the running server (no downtime), and writes a ready-to-use
# config. For phones it also prints a QR code you scan in the WireGuard app.
#
set -euo pipefail

WG_DIR="/etc/wireguard"
CLIENT_DIR="${WG_DIR}/clients"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root:  sudo bash add-client.sh <name>"
[ $# -ge 1 ] || die "Usage: sudo bash add-client.sh <name>   (e.g. my-phone)"

NAME="$1"
[[ "$NAME" =~ ^[A-Za-z0-9_-]+$ ]] || die "Name must be letters, numbers, dashes or underscores only."

[ -f "${WG_DIR}/server.env" ] || die "Run install-server.sh first (missing ${WG_DIR}/server.env)."
# shellcheck disable=SC1091
source "${WG_DIR}/server.env"
WG_CONF="${WG_DIR}/${WG_IF}.conf"

# DNS handed to clients — a public resolver, so DNS can't leak outside the tunnel.
CLIENT_DNS="${CLIENT_DNS:-1.1.1.1, 1.0.0.1}"

mkdir -p "$CLIENT_DIR"
umask 077

CLIENT_CONF="${CLIENT_DIR}/${NAME}.conf"
[ -f "$CLIENT_CONF" ] && die "A client named '${NAME}' already exists (${CLIENT_CONF}). Pick another name or run remove-client.sh first."

# --- Pick the next free VPN IP (10.x.x.2, .3, .4 ...) ------------------------
BASE="${WG_ADDR_V4%.*}"          # e.g. 10.66.66
USED="$(grep -oE "${BASE//./\\.}\.[0-9]+" "$WG_CONF" 2>/dev/null | awk -F. '{print $4}' | sort -n | uniq || true)"
NEXT=2
while echo "$USED" | grep -qx "$NEXT"; do NEXT=$((NEXT+1)); done
[ "$NEXT" -le 254 ] || die "VPN subnet is full."
CLIENT_V4="${BASE}.${NEXT}"

if [ "${HAVE_V6:-0}" -eq 1 ]; then
    V6_BASE="${WG_ADDR_V6%::*}"   # e.g. fd42:42:42
    CLIENT_V6="${V6_BASE}::${NEXT}"
fi

# --- Generate keys ----------------------------------------------------------
log "Generating keys for '${NAME}' (VPN IP ${CLIENT_V4})..."
CLIENT_PRIV="$(wg genkey)"
CLIENT_PUB="$(echo "$CLIENT_PRIV" | wg pubkey)"
PSK="$(wg genpsk)"                # extra symmetric key = defence in depth
SERVER_PUB="$(cat "${WG_DIR}/server_public.key")"

# Client's allowed IPs on the server side (its tunnel addresses only).
PEER_ALLOWED="${CLIENT_V4}/32"
[ "${HAVE_V6:-0}" -eq 1 ] && PEER_ALLOWED="${PEER_ALLOWED}, ${CLIENT_V6}/128"

# Full-tunnel: send ALL traffic through the VPN. Include ::/0 so IPv6 can't leak.
CLIENT_ALLOWED="0.0.0.0/0, ::/0"

CLIENT_ADDR="${CLIENT_V4}/32"
[ "${HAVE_V6:-0}" -eq 1 ] && CLIENT_ADDR="${CLIENT_ADDR}, ${CLIENT_V6}/128"

# --- 1. Register the peer with the live server (no restart) -----------------
# The `wg set` CLI wants allowed-ips comma-separated with no spaces; the config
# file (below) is fine with ", ".
log "Adding peer to the running server..."
wg set "$WG_IF" peer "$CLIENT_PUB" preshared-key <(echo "$PSK") allowed-ips "${PEER_ALLOWED// /}"

# --- 2. Persist the peer into the server config -----------------------------
{
    echo ""
    echo "[Peer]"
    echo "# ${NAME}"
    echo "PublicKey = ${CLIENT_PUB}"
    echo "PresharedKey = ${PSK}"
    echo "AllowedIPs = ${PEER_ALLOWED}"
} >> "$WG_CONF"

# --- 3. Write the client config ---------------------------------------------
cat > "$CLIENT_CONF" <<EOF
[Interface]
# ${NAME}
PrivateKey = ${CLIENT_PRIV}
Address = ${CLIENT_ADDR}
DNS = ${CLIENT_DNS}

[Peer]
PublicKey = ${SERVER_PUB}
PresharedKey = ${PSK}
Endpoint = ${SERVER_PUBLIC_IP}:${WG_PORT}
AllowedIPs = ${CLIENT_ALLOWED}
# Keeps the tunnel alive through NAT/firewalls (needed on phones).
PersistentKeepalive = 25
EOF
chmod 600 "$CLIENT_CONF"

# --- Done: show QR + path ---------------------------------------------------
printf '\n\033[1;32m✔ Client "%s" created.\033[0m\n\n' "$NAME"
echo "Config saved to: ${CLIENT_CONF}"
echo

if command -v qrencode >/dev/null 2>&1; then
    echo "📱 PHONE: open the WireGuard app → + → Scan from QR code, then scan this:"
    echo
    qrencode -t ansiutf8 < "$CLIENT_CONF"
    echo
fi

cat <<EOF
💻 LAPTOP/DESKTOP: copy the config file to your machine, e.g.

    scp ${USER:-saurabh_pro}@${SERVER_PUBLIC_IP}:${CLIENT_CONF} ~/${NAME}.conf

  then import it into the WireGuard app (or: wg-quick up ./${NAME}.conf on Linux).

To verify you're protected, visit https://ifconfig.me — it should show
${SERVER_PUBLIC_IP}, not your real IP.
EOF
