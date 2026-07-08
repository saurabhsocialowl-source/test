#!/usr/bin/env bash
#
# remove-client.sh — Revoke a VPN client (device).
#
# Run this ON the VPN server, as root:
#     sudo bash remove-client.sh <name>
#
# It removes the device from the live server immediately and deletes its stored
# config, so that device can no longer connect.
#
set -euo pipefail

WG_DIR="/etc/wireguard"
CLIENT_DIR="${WG_DIR}/clients"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Please run as root:  sudo bash remove-client.sh <name>"
[ $# -ge 1 ] || die "Usage: sudo bash remove-client.sh <name>"

NAME="$1"
[ -f "${WG_DIR}/server.env" ] || die "Missing ${WG_DIR}/server.env — is the server installed?"
# shellcheck disable=SC1091
source "${WG_DIR}/server.env"
WG_CONF="${WG_DIR}/${WG_IF}.conf"
CLIENT_CONF="${CLIENT_DIR}/${NAME}.conf"

[ -f "$CLIENT_CONF" ] || die "No client named '${NAME}' found."

# Find this client's public key so we can drop it from the live interface.
CLIENT_PRIV="$(awk -F' = ' '/^PrivateKey/{print $2; exit}' "$CLIENT_CONF")"
CLIENT_PUB="$(echo "$CLIENT_PRIV" | wg pubkey)"

log "Removing '${NAME}' from the running server..."
wg set "$WG_IF" peer "$CLIENT_PUB" remove || true

log "Scrubbing the peer from ${WG_CONF}..."
# Delete the [Peer] block whose comment line is "# <NAME>".
awk -v name="# ${NAME}" '
    BEGIN { RS=""; FS="\n" }
    {
        block=$0
        if (block ~ ("\\[Peer\\]") && block ~ (name "(\n|$)")) next
        print block "\n"
    }
' "$WG_CONF" > "${WG_CONF}.tmp"
mv "${WG_CONF}.tmp" "$WG_CONF"
chmod 600 "$WG_CONF"

rm -f "$CLIENT_CONF"

printf '\n\033[1;32m✔ Client "%s" revoked.\033[0m\n' "$NAME"
