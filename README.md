
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
