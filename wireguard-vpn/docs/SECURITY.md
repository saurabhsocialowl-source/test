# Security notes

This VPN is built to be safe by default. Here's what protects you and what to
keep in mind.

## What's already done for you

- **Per-device keys.** Every device gets its own WireGuard keypair *plus* a
  preshared key (an extra symmetric layer, "defence in depth"). There are no
  shared passwords to leak.
- **Modern crypto.** WireGuard uses Curve25519, ChaCha20-Poly1305, and BLAKE2s
  — current, well-regarded primitives with no configuration knobs to get wrong.
- **No DNS leaks.** Clients are pointed at `1.1.1.1` *inside* the tunnel, so DNS
  lookups don't reveal what you browse to the local network.
- **No IPv6 leaks.** Clients route `::/0` into the tunnel too, so IPv6 traffic
  can't sneak out around the VPN.
- **Silent to the internet.** WireGuard doesn't reply to unauthenticated
  packets — port scanners can't even tell the VPN is there.
- **Minimal exposure.** Only UDP `51820` is opened. Your existing services
  (SSH, nginx, Hermes) are untouched.

## Keep it that way

- **Protect the server configs.** `/etc/wireguard/` (server keys) and
  `/etc/wireguard/clients/` (device configs) are readable only by root. A device
  `.conf` grants VPN access — treat each one like a password. Delete the local
  copy after you've imported it into a device's WireGuard app.
- **Revoke lost devices immediately.** If a phone/laptop is lost or sold:
  ```bash
  sudo bash remove-client.sh <name>
  ```
  That drops it from the live server at once.
- **Keep the box patched.** `sudo apt update && sudo apt upgrade` periodically —
  WireGuard rides on the kernel, so normal system updates cover it.
- **Don't widen the firewall.** Only `51820/udp` needs to be open for the VPN.
  Resist adding "Any/Any" NSG rules.

## What this VPN does and doesn't do

- ✅ Stops people on your local network (WiFi) from snooping on your traffic.
- ✅ Hides your real IP from the websites you visit (they see the server's IP).
- ✅ Lets you appear to browse from the server's location.
- ❌ It is **not** anonymity. Your traffic exits from a server registered to you,
  so it's not comparable to Tor. It's about privacy on untrusted networks and
  control over your own exit point — which is exactly what "personal VPN" means.
