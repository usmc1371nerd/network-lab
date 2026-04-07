
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
- **Forwarding devices** (switch, router, gateway): act as transit hops in multi-hop ping routing
- A single device can connect to multiple other devices.
- Link type is selectable when creating a connection and editable later from the Link panel.

Link Condition Labels:
- Each edge displays `CAT · loss% · latency±jitter · bwXpps · qX` for both outbound and inbound directions
- Click the `i` button on a selected edge to open the link editor and configure these values
- Presets available: Stable / Congested / Hostile

Quick Start:
0) One-command startup (PowerShell)
- From project root:
- `./dev-start.ps1`

1) Backend (Flask)
- `cd backend`
- `python app.py`
- Backend URL: `http://localhost:5000`
- API route: `POST /api/run-command`

2) Frontend (Vite)
- `cd frontend`
- `npm install`
- `npm run dev`
- Frontend URL: `http://localhost:3000`

3) Build frontend
- `cd frontend`
- `npm run build`

Troubleshooting:
- Port already in use
	- Backend (`5000`) or frontend (`3000`) may already be running in another terminal.
	- Check listeners in PowerShell: `Get-NetTCPConnection -LocalPort 5000,3000 -State Listen`

- Backend fails to start (missing Flask modules)
	- Install required packages:
	- `python -m pip install flask flask-cors`

- Frontend command fails or missing dependencies
	- Reinstall dependencies in `frontend`:
	- `npm install`

- Running command from wrong folder
	- Frontend commands (`npm run dev`, `npm run build`) must run in `frontend`.
	- Backend command (`python app.py`) must run in `backend`.
