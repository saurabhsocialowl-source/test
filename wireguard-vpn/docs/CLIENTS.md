# Connecting your devices

First, on the server, create a config for the device:

```bash
sudo bash add-client.sh <name>     # e.g. my-phone, work-laptop
```

Then follow the section below for that device type.

---

## 📱 iPhone / iPad

1. Install **WireGuard** from the App Store.
2. On the server, `add-client.sh` printed a **QR code** in the terminal. (To
   show it again later: `qrencode -t ansiutf8 < /etc/wireguard/clients/<name>.conf`.)
3. In the WireGuard app: **➕ → Create from QR code** → scan the terminal.
4. Give it a name, tap **Save**, allow the VPN configuration when iOS asks.
5. Toggle the tunnel **on**.

Tip: enable **On-Demand** in the app so it auto-connects on untrusted WiFi.

---

## 🤖 Android

Same as iPhone — install **WireGuard** from the Play Store, then
**➕ → Scan from QR code** and scan the QR the script printed.

---

## 💻 macOS

1. Install **WireGuard** from the Mac App Store.
2. Copy the config from the server to your Mac:
   ```bash
   scp saurabh_pro@20.46.146.83:/etc/wireguard/clients/<name>.conf ~/<name>.conf
   ```
3. In the WireGuard app: **Import tunnel(s) from file…** → pick the `.conf`.
4. Click **Activate**.

---

## 🪟 Windows

1. Install **WireGuard** from <https://www.wireguard.com/install/>.
2. Copy the `.conf` file to your PC (via `scp`, or an SFTP tool like WinSCP).
3. In the WireGuard app: **Import tunnel(s) from file** → pick the `.conf`.
4. Click **Activate**.

---

## 🐧 Linux

```bash
# Copy the config down:
scp saurabh_pro@20.46.146.83:/etc/wireguard/clients/<name>.conf ~/<name>.conf

# Option A — bring it up ad-hoc:
sudo wg-quick up ~/<name>.conf
sudo wg-quick down ~/<name>.conf

# Option B — install it as a managed service:
sudo cp ~/<name>.conf /etc/wireguard/
sudo systemctl enable --now wg-quick@<name>
```

---

## Did it work?

With the tunnel **on**:

- Visit **https://ifconfig.me** → should show **`20.46.146.83`** (your server),
  not your home/coffee-shop IP.
- Visit **https://dnsleaktest.com** → run the standard test; servers shown
  should be Cloudflare (`1.1.1.1`), confirming DNS isn't leaking.

If the IP still shows your real one, the tunnel isn't actually up — check that
you opened the Azure port (see `AZURE-SETUP.md`) and that `sudo wg show` on the
server lists a recent handshake for your device.
