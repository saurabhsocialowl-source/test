#!/usr/bin/env bash
#
# install-server.sh — Set up a WireGuard VPN server for personal secure browsing.
#
# This configures a "full-tunnel" VPN: ALL of a connected device's internet
# traffic is encrypted and routed out through this server. On untrusted WiFi
# nobody can snoop on you, and your public IP becomes this server's IP.
#
# Run this ON the VPN server (e.g. your Azure VM), as root:
#     sudo bash install-server.sh
#
# It is idempotent — safe to re-run. It will NOT touch anything unrelated to
# WireGuard (your existing nginx / Hermes / other services are left alone).
#
set -euo pipefail

# --- Tunable settings (override by exporting before running) ----------------
WG_IF="${WG_IF:-wg0}"                       # WireGuard interface name
WG_PORT="${WG_PORT:-51820}"                 # UDP port WireGuard listens on
WG_ADDR_V4="${WG_ADDR_V4:-10.66.66.1}"      # Server's VPN IPv4 address
WG_CIDR_V4="${WG_CIDR_V4:-24}"              # VPN IPv4 subnet size
WG_ADDR_V6="${WG_ADDR_V6:-fd42:42:42::1}"   # Server's VPN IPv6 (ULA) address
WG_CIDR_V6="${WG_CIDR_V6:-64}"              # VPN IPv6 subnet size
SERVER_PUBLIC_IP="${SERVER_PUBLIC_IP:-}"    # Override auto-detection if needed

WG_DIR="/etc/wireguard"
WG_CONF="${WG_DIR}/${WG_IF}.conf"

# --- Helpers ----------------------------------------------------------------
log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root:  sudo bash install-server.sh"

# --- 1. Detect the network environment --------------------------------------
WAN_IF="$(ip -4 route list default | awk '{print $5; exit}')"
[ -n "$WAN_IF" ] || die "Could not detect the default network interface."
log "Uplink (WAN) interface: ${WAN_IF}"

# Does this host have working outbound IPv6? Only then do we NAT IPv6.
if ip -6 route show default 2>/dev/null | grep -q .; then
    HAVE_V6=1
    log "IPv6 uplink detected — the tunnel will carry IPv6 too."
else
    HAVE_V6=0
    warn "No IPv6 uplink — tunnel will be IPv4-only (IPv6 is safely null-routed to prevent leaks)."
fi

# Figure out the public IP clients will connect to (the tunnel endpoint).
if [ -z "$SERVER_PUBLIC_IP" ]; then
    for url in "https://api.ipify.org" "https://ifconfig.me" "https://icanhazip.com"; do
        SERVER_PUBLIC_IP="$(curl -fsS --max-time 8 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
        [ -n "$SERVER_PUBLIC_IP" ] && break
    done
fi
[ -n "$SERVER_PUBLIC_IP" ] || die "Could not auto-detect public IP. Re-run with: SERVER_PUBLIC_IP=<your.ip> sudo -E bash install-server.sh"
log "Server public endpoint: ${SERVER_PUBLIC_IP}:${WG_PORT}"

# --- 2. Install packages ----------------------------------------------------
if ! command -v wg >/dev/null 2>&1; then
    log "Installing WireGuard..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq wireguard qrencode
else
    log "WireGuard already installed — skipping."
    command -v qrencode >/dev/null 2>&1 || apt-get install -y -qq qrencode || true
fi

# --- 3. Enable kernel IP forwarding (persistent) ----------------------------
log "Enabling IP forwarding..."
SYSCTL_FILE="/etc/sysctl.d/99-wireguard.conf"
{
    echo "net.ipv4.ip_forward = 1"
    [ "$HAVE_V6" -eq 1 ] && echo "net.ipv6.conf.all.forwarding = 1"
} > "$SYSCTL_FILE"
sysctl -q --system

# --- 4. Generate the server keypair (only once) -----------------------------
umask 077
mkdir -p "$WG_DIR"
if [ ! -f "${WG_DIR}/server_private.key" ]; then
    log "Generating server keypair..."
    wg genkey | tee "${WG_DIR}/server_private.key" | wg pubkey > "${WG_DIR}/server_public.key"
else
    log "Server keypair already exists — reusing it."
fi
SERVER_PRIV="$(cat "${WG_DIR}/server_private.key")"

# --- 5. Build NAT / firewall rules for full-tunnel routing ------------------
POSTUP="iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT; iptables -t nat -A POSTROUTING -o ${WAN_IF} -j MASQUERADE"
POSTDOWN="iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT; iptables -t nat -D POSTROUTING -o ${WAN_IF} -j MASQUERADE"
if [ "$HAVE_V6" -eq 1 ]; then
    POSTUP="${POSTUP}; ip6tables -A FORWARD -i %i -j ACCEPT; ip6tables -A FORWARD -o %i -j ACCEPT; ip6tables -t nat -A POSTROUTING -o ${WAN_IF} -j MASQUERADE"
    POSTDOWN="${POSTDOWN}; ip6tables -D FORWARD -i %i -j ACCEPT; ip6tables -D FORWARD -o %i -j ACCEPT; ip6tables -t nat -D POSTROUTING -o ${WAN_IF} -j MASQUERADE"
fi

# --- 6. Write the server config (preserving any existing [Peer] blocks) -----
if [ -f "$WG_CONF" ] && grep -q '^\[Peer\]' "$WG_CONF"; then
    log "Existing peers found — keeping them, refreshing [Interface] only."
    # Extract everything from the first [Peer] onward, then re-prepend a fresh interface.
    EXISTING_PEERS="$(awk '/^\[Peer\]/{p=1} p' "$WG_CONF")"
else
    EXISTING_PEERS=""
fi

ADDR_LINE="${WG_ADDR_V4}/${WG_CIDR_V4}"
[ "$HAVE_V6" -eq 1 ] && ADDR_LINE="${ADDR_LINE}, ${WG_ADDR_V6}/${WG_CIDR_V6}"

{
    echo "# Managed by install-server.sh — WireGuard personal VPN"
    echo "[Interface]"
    echo "Address = ${ADDR_LINE}"
    echo "ListenPort = ${WG_PORT}"
    echo "PrivateKey = ${SERVER_PRIV}"
    echo "PostUp = ${POSTUP}"
    echo "PostDown = ${POSTDOWN}"
    if [ -n "$EXISTING_PEERS" ]; then
        echo ""
        echo "$EXISTING_PEERS"
    fi
} > "$WG_CONF"
chmod 600 "$WG_CONF"

# --- 7. Open the firewall (ufw if present) ----------------------------------
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    log "Opening UDP ${WG_PORT} in ufw..."
    ufw allow "${WG_PORT}/udp" >/dev/null || true
    ufw route allow in on "${WG_IF}" out on "${WAN_IF}" >/dev/null 2>&1 || true
fi

# --- 8. Start & enable the service ------------------------------------------
log "Starting WireGuard (${WG_IF})..."
systemctl enable "wg-quick@${WG_IF}" >/dev/null 2>&1 || true
# Reload cleanly whether or not it was already up.
if systemctl is-active --quiet "wg-quick@${WG_IF}"; then
    wg syncconf "${WG_IF}" <(wg-quick strip "${WG_IF}")
else
    systemctl restart "wg-quick@${WG_IF}"
fi

# --- 9. Save the settings so add-client.sh can reuse them -------------------
cat > "${WG_DIR}/server.env" <<EOF
SERVER_PUBLIC_IP=${SERVER_PUBLIC_IP}
WG_IF=${WG_IF}
WG_PORT=${WG_PORT}
WG_ADDR_V4=${WG_ADDR_V4}
WG_ADDR_V6=${WG_ADDR_V6}
HAVE_V6=${HAVE_V6}
EOF
chmod 600 "${WG_DIR}/server.env"

# --- Done -------------------------------------------------------------------
cat <<EOF

$(printf '\033[1;32m✔ WireGuard server is up.\033[0m')

  Endpoint : ${SERVER_PUBLIC_IP}:${WG_PORT}/udp
  Server IP: ${WG_ADDR_V4}
  Config   : ${WG_CONF}

$(printf '\033[1;33mNEXT STEPS:\033[0m')

  1) OPEN THE PORT IN AZURE (this is the step people forget):
     Azure Portal → your VM → Networking → Add inbound port rule
        Port: ${WG_PORT}   Protocol: UDP   Action: Allow
     (Details in docs/AZURE-SETUP.md)

  2) Create a device config:
        sudo bash add-client.sh my-phone
        sudo bash add-client.sh my-laptop

EOF
