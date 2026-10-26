
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
- **Zoom**: Hold Ctrl (or Cmd on Mac) and scroll the mouse wheel to zoom in/out, anchored to cursor
- **Pan**: Hold Spacebar and drag to move the canvas around (similar to Obsidian note-taking)
- **No boundaries**: Devices can be placed and dragged anywhere — pan to navigate to off-screen devices
- **Terminal Toolbar**: Click the toggle button (▲/▼) at bottom-right to collapse/expand the terminal and packet log panel

Device Rules:
- **IP-capable** (PC, Server, Router, Switch, Gateway, Laptop, Phone, IoT): assignable IPs, pingable, routable
- **Non-IP peripherals** (USB HID, USB storage, BLE beacon/sensor/tag): no IP, not pingable, no traffic counters
- **USB devices are host-local**: a USB mouse on PC-1 is physically attached to PC-1 only — PC-2 cannot address it.
	`lsusb` run from PC-1's SSH session shows only devices with a canvas edge to PC-1.
- **Layer 2 transit**: switches, hubs, and access points bridge same-subnet traffic. PCs, servers, laptops, phones, and USB peripherals do not forward traffic between cables.
- **Routed transit**: routers and gateways can be selected as explicit next hops for destinations outside the source subnet. A canvas path alone does not create an IP route.
- **Ping delivery**: the backend applies link direction, blocking, loss, latency, jitter, bandwidth, queue, and RED settings before reporting replies. Failed ARP resolution does not populate the source cache or generate ICMP replies. The frontend uses physical hop IDs to animate and count traffic, and preserves the backend delivery result.
- **Example**: `PC-1 → PC-2 → Server` cannot carry transit traffic through PC-2. Replace PC-2 with a switch (same subnet), or use a router/gateway with a configured route. USB storage cannot provide a second network path.
- Routing remains a teaching model with one IP per device; it does not model a full router with per-interface subnets and neighbor discovery.
- A single device can connect to multiple other devices.
- Link type is selectable when creating a connection and editable later from the Link panel.
- To disconnect devices, click their connection and choose **Disconnect** in the Link panel. To connect a device elsewhere, click **Connect**, then select the two devices for the new link. Disconnecting removes the cable and its link counters; both devices remain on the canvas.

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
