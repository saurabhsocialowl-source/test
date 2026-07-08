# Opening the VPN port in Azure

Azure has **two** firewalls in front of your VM:

1. The VM's own firewall (`ufw`) — the installer handles this for you.
2. Azure's **Network Security Group (NSG)** — a cloud-level firewall. This one
   blocks the VPN port by default, and you must open it yourself in the portal.

If you skip step 2, `install-server.sh` will finish fine but your devices will
**time out** when they try to connect. This is the #1 reason a cloud VPN "doesn't
work."

---

## Open UDP 51820 (Azure Portal)

1. Go to the [Azure Portal](https://portal.azure.com) → **Virtual machines** →
   select your VM (the one at `20.46.146.83`).
2. In the left menu, click **Networking** (under *Settings*).
3. On the **Inbound port rules** tab, click **➕ Add inbound port rule**.
4. Fill in:

   | Field | Value |
   |---|---|
   | Source | `Any` |
   | Source port ranges | `*` |
   | Destination | `Any` |
   | Service | `Custom` |
   | Destination port ranges | `51820` |
   | Protocol | **UDP** |
   | Action | **Allow** |
   | Priority | `310` (any free number below 65500) |
   | Name | `Allow-WireGuard-UDP` |

5. Click **Add**. The rule takes effect within a few seconds.

> **Protocol must be UDP.** WireGuard does not use TCP. If you pick TCP or
> "Any" it may look right but silently fail.

---

## Doing it from the Azure CLI instead

If you have the `az` CLI set up locally:

```bash
# Find the NSG name attached to your VM's NIC:
az network nsg list -o table

# Add the rule (replace <RESOURCE_GROUP> and <NSG_NAME>):
az network nsg rule create \
  --resource-group <RESOURCE_GROUP> \
  --nsg-name <NSG_NAME> \
  --name Allow-WireGuard-UDP \
  --priority 310 \
  --direction Inbound \
  --access Allow \
  --protocol Udp \
  --destination-port-ranges 51820 \
  --source-address-prefixes '*'
```

---

## Verifying the port is open

From your laptop (with the VPN **off**), a quick reachability check:

```bash
# nc in UDP mode won't confirm much on its own, so the real test is simply:
# add a client, connect, and run `sudo wg show` on the server — a recent
# "latest handshake" means the port is open and traffic is flowing.
```

On the server, after a device tries to connect:

```bash
sudo wg show
```

Look for a **`latest handshake`** line under the peer. If it shows a recent
time (seconds ago), the port is open and the VPN is working. If it stays empty,
the NSG rule is missing or wrong.
