# Personal WireGuard VPN

A simple, self-hosted VPN for **secure browsing**. When your phone or laptop is
connected, **all** of its internet traffic is encrypted and routed out through
your own server. On coffee-shop / airport / hotel WiFi nobody can snoop on you,
and to the sites you visit your IP looks like the server's IP.

It uses [WireGuard](https://www.wireguard.com/) — the modern standard for
personal VPNs: fast, tiny, audited, and built into the Linux kernel.

> **Your setup:** These scripts are meant to run on your **Azure VM**
> (`20.46.146.83`, user `saurabh_pro`). That box already runs your Hermes AI
> stack — WireGuard is lightweight and sits alongside it without touching any
> of your existing nginx / services.

---

## What's here

| File | What it does |
|---|---|
| `install-server.sh` | One-time server setup: installs WireGuard, enables routing + NAT, opens the firewall, starts the service. Idempotent — safe to re-run. |
| `add-client.sh` | Creates a config for one device. Prints a QR code for phones. Run once per device. |
| `remove-client.sh` | Revokes a device so it can no longer connect. |
| `docs/AZURE-SETUP.md` | **Required:** open the VPN port in the Azure portal. |
| `docs/CLIENTS.md` | How to connect from iPhone / Android / macOS / Windows / Linux. |
| `docs/SECURITY.md` | How it's secured and how to keep it that way. |

---

## Quick start

### 1. Copy these scripts onto the server

From your laptop, in this folder:

```bash
scp -r wireguard-vpn saurabh_pro@20.46.146.83:~/
```

### 2. Run the installer on the server

```bash
ssh saurabh_pro@20.46.146.83
cd ~/wireguard-vpn
sudo bash install-server.sh
```

It auto-detects your public IP and network interface, sets everything up, and
prints your endpoint. Takes about a minute.

### 3. Open the port in Azure  ← don't skip this

Azure blocks the VPN port by default at the cloud firewall, **separately** from
the server's own firewall. You must add an inbound rule for **UDP 51820**.

👉 Step-by-step with screenshots-worth-of-detail in **[docs/AZURE-SETUP.md](docs/AZURE-SETUP.md)**.

### 4. Add your devices

```bash
sudo bash add-client.sh my-phone      # prints a QR code — scan it in the app
sudo bash add-client.sh my-laptop     # copy the .conf to your laptop
```

Connecting instructions per device: **[docs/CLIENTS.md](docs/CLIENTS.md)**.

### 5. Confirm it works

Turn the VPN on, then visit **https://ifconfig.me**. It should show
`20.46.146.83` — your server — not your real IP. Also check
**https://dnsleaktest.com** to confirm DNS isn't leaking.

---

## Day-to-day use

- **Add a device:** `sudo bash add-client.sh <name>`
- **Remove a device:** `sudo bash remove-client.sh <name>`
- **List connected devices:** `sudo wg show`
- **Restart the VPN:** `sudo systemctl restart wg-quick@wg0`
- **Client configs live at:** `/etc/wireguard/clients/` on the server

---

## How it works (the 30-second version)

```
  Your phone ──encrypted tunnel──▶  Azure VM  ──▶  the internet
 (untrusted WiFi)                 (WireGuard)      (your traffic exits here)
```

- Each device gets its own keypair + a preshared key. No shared passwords.
- The client is told `AllowedIPs = 0.0.0.0/0, ::/0` → send *everything* through
  the tunnel (full-tunnel VPN).
- The server enables IP forwarding and NATs (masquerades) that traffic out to
  the internet, so replies come back through the tunnel.
- Clients use `1.1.1.1` for DNS *inside* the tunnel, so DNS queries don't leak.

---

## Cost

**$0 extra.** You're reusing the Azure VM you already pay for. WireGuard adds
negligible CPU/RAM. The only "cost" is outbound bandwidth, which for personal
browsing is well within a normal VM's allowance.
