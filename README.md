
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
