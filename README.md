
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
- Drag-and-drop topology canvas
- Per-link direction and realism controls (loss, latency, jitter, queue, bandwidth, RED)
- Terminal-driven packet generation and packet log inspection
- Security insight overlays (device/link level, topology-based guidance)

Connection Types:
- CAT (Ethernet)
- WiFi
- USB
- Bluetooth

Notes:
- A single device can connect to multiple other devices.
- Link type is selectable when creating a connection and editable later from the Link panel.
- Existing legacy `network` links are treated as CAT/Ethernet.

Quick Start:
0) One-command startup (PowerShell)
- From project root:
- `./dev-start.ps1`

1) Backend (Flask)
- `cd backend`
- `C:/Users/hackerdad/AppData/Local/Programs/Python/Python313/python.exe app.py`
- Backend URL: `http://localhost:5000`

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
	- `C:/Users/hackerdad/AppData/Local/Programs/Python/Python313/python.exe -m pip install flask flask-cors`

- Frontend command fails or missing dependencies
	- Reinstall dependencies in `frontend`:
	- `npm install`

- Running command from wrong folder
	- Frontend commands (`npm run dev`, `npm run build`) must run in `frontend`.
	- Backend command (`python app.py`) must run in `backend`.
