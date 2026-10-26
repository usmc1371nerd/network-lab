
# Network Lab Interactive Trainer

Stack:
Frontend: React
Backend: Flask

Goal:
Interactive networking simulator for learning:
- IP ranges
- packet flow
- terminal commands
- wireshark-like packet log

Key Features:
- Drag-and-drop topology canvas (unbounded world space — no movement limits)
- Device capability policy: IP-capable vs non-IP peripherals enforced in UI and backend
- Per-link direction and realism controls (loss, latency, jitter, queue, bandwidth, RED)
- Link condition labels on each edge showing current simulation parameters
- Terminal-driven packet generation and packet log inspection
- Split DEV/IP traffic counters per device node (peripherals show no counters)
- Security insight overlays (device/link level, topology-based guidance)

Connection Types:
- CAT (Ethernet)
- WiFi
- USB
- Bluetooth

Canvas Controls:
- **Device details**: nodes show their name and IP by default. Click **Details** to expand traffic counters, MAC address, ARP count, and device type; click **Hide details** to collapse them.
- **Zoom**: Hold Ctrl (or Cmd on Mac) and scroll the mouse wheel to zoom in/out, anchored to cursor
- **Pan**: Hold Spacebar and drag to move the canvas around (similar to Obsidian note-taking)
- **No boundaries**: Devices can be placed and dragged anywhere — pan to navigate to off-screen devices
- **Terminal Toolbar**: Click the toggle button (▲/▼) at bottom-right to collapse/expand the terminal and packet log panel

Device Rules:
- **Firewall** is available under **Core**. Choose **Open dashboard** on its node to assign interface subnets, edit ordered ingress rules, inspect live decisions, and run ping diagnostics. Filtering is opt-in; enabled firewalls default to denying unmatched ICMP. JSON backups preserve applied settings.
- **IP-capable** (PC, Server, Router, Firewall, Switch, Gateway, Laptop, Phone, IoT): assignable IPs, pingable, routable
- **Non-IP peripherals** (USB HID, USB storage, BLE beacon/sensor/tag): no IP, not pingable, no traffic counters
- **USB devices are host-local**: a USB mouse on PC-1 is physically attached to PC-1 only — PC-2 cannot address it.
	`lsusb` run from PC-1's SSH session shows only devices with a canvas edge to PC-1.
- **Layer 2 transit**: switches, hubs, and access points bridge same-subnet traffic. PCs, servers, laptops, phones, and USB peripherals do not forward traffic between cables.
- **Routed transit**: routers, firewalls, and gateways can be selected as explicit next hops for destinations outside the source subnet. A canvas path alone does not create an IP route.
- **Ping delivery**: the backend applies link direction, blocking, loss, latency, jitter, bandwidth, queue, and RED settings before reporting replies. Failed ARP resolution does not populate the source cache or generate ICMP replies. The frontend uses physical hop IDs to animate and count traffic, and preserves the backend delivery result.
- **Example**: `PC-1 → PC-2 → Server` cannot carry transit traffic through PC-2. Replace PC-2 with a switch (same subnet), or use a router/gateway with a configured route. USB storage cannot provide a second network path.
- Routing is a teaching model: ordinary routers have one IP, while configured firewalls have per-cable IPv4 interfaces. Endpoint routes are configured explicitly. Firewall filtering covers ping only; TCP/UDP, NAT execution, DHCP, VLANs, VPNs, and cross-command state tracking are not implemented.
- A single device can connect to multiple other devices.
- Link type is selectable when creating a connection and editable later from the Link panel.
- To disconnect devices, click their connection and choose **Disconnect** in the Link panel. To connect a device elsewhere, click **Connect**, then select the two devices for the new link. Disconnecting removes the cable and its link counters; both devices remain on the canvas.
- To remove a device entirely, click the **×** at the top-right of its node, or open its **i** panel and choose **Remove device**. This removes the device, all attached cables, and their traffic state. Other devices remain on the canvas.

Link Condition Labels:
- Each edge displays `CAT · loss% · latency±jitter · bwXpps · qX` for both outbound and inbound directions
- Click the `i` button on a selected edge to open the link editor and configure these values
- Presets available: Stable / Congested / Hostile

Quick Start (Linux / Bash):

Install Python 3 with venv support, Node.js/npm (Node 18+), and `setsid` (from `util-linux`). From the project root, set up dependencies once:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
(cd frontend && npm ci)
```

Start both services:

```bash
./dev-start.sh
```

You can also run `bash dev-start.sh`. The script finds the project relative to its own location, so it works when invoked from another directory. It prefers `.venv/bin/python`, falling back to `python3`.

Open `http://localhost:3000`. Backend API: `http://localhost:5000/api/run-command` (`POST`). Both services print logs in the current terminal. Press Ctrl+C to stop the services this script started. Existing listeners on ports 5000 or 3000 are left running. If either new service fails, the script stops the other service it started.

Flask runs in debug mode with automatic Python reloading disabled; restart the script after backend changes. Vite reloads frontend changes automatically.

Windows / PowerShell startup is still available: `./dev-start.ps1`.

To run the services separately, use two terminals from the project root:

```bash
# Terminal 1: backend
.venv/bin/python backend/app.py
```

```bash
# Terminal 2: frontend
cd frontend
npm run dev
```

Build frontend:
- `cd frontend`
- `npm run build`

Troubleshooting:
- Port already in use
	- Backend (`5000`) or frontend (`3000`) may already be running in another terminal.
	- Check listeners on Linux: `ss -ltnp '( sport = :5000 or sport = :3000 )'`
	- Check listeners in PowerShell: `Get-NetTCPConnection -LocalPort 5000,3000 -State Listen`

- Backend fails to start (missing Flask modules)
	- Install required packages:
	- `.venv/bin/python -m pip install -r requirements.txt` (from the project root)

- Frontend command fails or missing dependencies
	- Reinstall dependencies in `frontend`:
	- `npm ci`

- Running command from wrong folder
	- Frontend commands (`npm run dev`, `npm run build`) must run in `frontend`.
	- Backend command (`python app.py`) must run in `backend`.

Regression checks:
- Backend: `.venv/bin/python -m unittest discover -s backend -v` (requires Flask and flask-cors).
- Frontend: `cd frontend`, then `npm test` and `npm run build`.

Lab backups (no database or account required):
- Click **Export lab** in the header to download a versioned `.json` backup. Keep the downloaded file; labs are not saved automatically.
- Click **Import lab** and choose a previously exported JSON file. The file is validated before anything changes. If a lab is already open, confirm its replacement or cancel to keep working.
- Backups include device names, positions, IP/MAC settings, routes, connections and link conditions, canvas zoom/pan, and expanded device panels. Additional device configuration fields (such as future firewall interfaces, rules, and NAT configuration) are preserved.
- Import starts a fresh simulation: learned ARP/MAC tables, packet captures, counters, animations, queues, and terminal sessions reset.
- **Unexported changes** indicates that configuration has changed since the last export/import. Refreshing or leaving prompts a browser warning when there are unexported changes; browsers may suppress that warning, so export before leaving.
- Invalid or unsupported backups leave the current lab untouched. Version 1 supports files up to 5 MB, 1,000 devices, and 10,000 connections.
- Backup files stay in your browser/downloads and are not uploaded to the server. This feature does not require database hosting or persistent Render storage.

Firewall dashboard:
- Add a Firewall under Core, connect its cables, and click **Open dashboard**. The workspace takes the place of the topology while the terminal stays available below it. **Back to topology** returns to the canvas.
- In **Interfaces**, add LAN, WAN, or OPT entries. Assign each enabled interface to a different connected neighbor and set its IPv4 address/prefix. Put PCs sharing a LAN behind a switch; assign the firewall's LAN interface to that switch. Enabled interface subnets cannot overlap.
- Click **Apply changes** to use edited settings. Use **Discard** to abandon unapplied edits. Apply or discard pending settings before exporting a lab; a refresh warning covers pending settings too.
- Configure routes on both endpoints. For LAN `10.10.10.1/24` and a server on `10.10.30.0/24`, run `ip route add 10.10.30.0/24 via 10.10.10.1` from the LAN PC. With firewall WAN `10.10.30.1/24`, add `ip route add 10.10.10.0/24 via 10.10.30.1` from the server. Existing lab routes are preserved.
- In **Firewall rules**, add an enabled **Pass** rule on LAN, protocol **ICMP**, source **interface-net**, destination **any** (or the server IP/subnet). Enable filtering and apply. Rules are evaluated top to bottom on the incoming interface; the first match wins. No match means Block. `interface-net` refers to the incoming interface's subnet for either address field.
- Each allowed ICMP request creates state for its reply during that ping command. A newly initiated reverse-direction ping needs its own ingress rule. The simulator does not persist states across commands or require a separate reply rule.
- **Live log** explains default-deny, explicit rule matches, and state-matched replies, independently of packet capture. The lab keeps up to 500 recent decisions; logs reset on import or refresh. Packet captures also show FIREWALL decision records when enabled.
- **Routing** lists connected interface networks and configured static routes. **Diagnostics** sends a ping from a selected firewall address. To exercise ingress filtering, ping from a connected endpoint in the terminal.
- ARP for an off-subnet destination resolves the local gateway, rather than crossing the firewall. Ethernet MAC addresses are updated at routed hops. Neighbor discovery is still simplified; a full per-interface ARP exchange on every routed segment is not modeled.
- Removing a cable or device disables the attached firewall interface. If no enabled interface remains, filtering is turned off. Reassign and apply interface settings after reconnecting.
- This is an OPNsense-inspired simulator, not OPNsense software. The implemented rule engine covers IPv4 ICMP ping. Terminal `sendpkt` and `traceroute` do not use it. NAT fields may be preserved in backups, but NAT execution and a NAT editor are not implemented.

Rule behavior references: [OPNsense interface rules](https://docs.opnsense.org/manual/firewall.html) and [interface configuration](https://docs.opnsense.org/manual/interfaces.html).
