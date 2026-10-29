
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
- Invalid or unsupported backups leave the current lab untouched. Version 2 exports include both lab and inventory and support files up to 5 MB, 1,000 lab devices, 1,000 inventory assets, and 10,000 lab connections. Version 1 backups still import. Older app versions reject version 2 files rather than silently discarding inventory.
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

Device profiles and inventory:
- Click **Edit** at the top-left of a device to change its display name, type, configured IPv4 address, and notes. Name changes keep the device's internal ID and cable references intact. Names must not conflict with another device's name, ID, or IP.
- Names can contain spaces. Use quoted names in simulated commands, such as `ssh "Office PC"`, `ping "Office Server"`, or `ble connect "Living Room Sensor"`. The profile shows an SSH command example for IP-capable devices. These commands remain simulated; they do not authenticate to physical computers.
- IP fields accept IPv4 addresses with an optional prefix, such as `10.10.10.10/24`. Duplicate configured addresses are rejected by the profile editor. A configured firewall's interface addresses are edited in its dashboard.
- **Save profile** applies changes to the lab. **Cancel**, the close button, or Escape discards unapplied edits. Export is disabled while profile edits are pending; a browser refresh/exit warning also covers pending edits.
- Changing to a non-IP peripheral clears its simulated IP, routes, and incompatible learned state. Changing a configured firewall to another type asks before removing interface/rule/NAT configuration. Existing cables remain; review their connection types after a device-type change.
- **Discovery observations** are separate, read-only records. The model supports a source, timestamp, discovered hostname, observed IPv4/MAC addresses, suggested device type, confidence, and supporting evidence. First/last-seen timestamps are retained alongside up to 100 recent observations.
- New observations add evidence without overwriting configured names, types, addresses, notes, or user override flags. JSON backups preserve profile and discovery metadata; older lab files without it still load.
- Local Linux discovery is available through **Discover local network** when started with dev-start.sh. Hosted deployments continue to use XML import; lab devices without observations show an empty discovery panel.

Nmap XML import and discovered inventory:
- Click **Import Nmap scan** in the header, or open **Inventory** and choose **Import Nmap XML**. Choose a standard XML file exported by Nmap (`-oX`), or click **Try a sample file** for clearly labeled example data. No Nmap installation is needed to try the sample.
- XML file import parses entirely in the browser. Importing a file does not upload it, run Nmap, probe devices, authenticate to hosts, or change their configuration. Custom XML entities and external DTDs are rejected; the usual plain `<!DOCTYPE nmaprun>` declaration is accepted.
- Review individual IPv4 hosts reported as up before importing. Down/unknown-status hosts, IPv6-only hosts, and duplicate address records are counted as skipped. The first 128 individually listed port records per host are retained, with truncation noted. Raw script output is not imported.
- The review screen shows observed IP, hostname, MAC/vendor, and explicit Nmap device-class suggestions. New inventory assets begin as **Unknown device**; a general-purpose OS or an open SSH port is not enough to classify a host as a PC or server. Confirm roles through **Edit profile**.
- Matching by MAC suggests an existing asset but still requires review. IP-only matches, changed MACs at a previously seen IP, and shared MAC identities are unchecked by default. Choose the intended existing asset or create a separate one, then explicitly include the row. An IP address is not treated as a permanent device identity.
- Applying a scan adds observations without replacing curated names, types, notes, or lab IP overrides. Reimporting the same observations does not grow history with duplicates. Assets absent from a new scan remain in inventory; absence does not establish that a device is offline.
- Inventory is separate from the simulated Lab. It shows last-seen scan evidence, not current reachability or physical topology. No switch, cable, gateway, or subnet is invented from host discovery alone.
- Select inventory assets and choose **Add selected to practice lab** to create independent simulated copies. Their IDs differ from inventory IDs; their observed evidence is retained, but no cables or routes are added. Configure connections and routes yourself. Copies use an observed IP with the simulator's explicit `/24` default unless you set a different lab IPv4 override in the inventory profile. The scan did not establish that prefix.
- Duplicate practice IPs are rejected without changing the lab. Edit the inventory asset's optional lab IPv4 override to choose a different practice address; the observed address remains read only.
- **Export lab** now backs up both workspaces. **Import lab** restores both after replacement confirmation. Inventory-only backups reopen Inventory; existing version 1 lab files restore with an empty inventory.
- Limits: XML files up to 5 MB and 1,000 host records per file; inventory up to 1,000 assets. Backup size remains capped at 5 MB, so very large selections/history may need to be split into smaller workspaces.

Nmap format reference: [official XML output documentation](https://nmap.org/book/output-formats-xml-output.html).

Local Linux discovery:
- Install the optional local tools `nmap` and `iproute2`. On Ubuntu/Debian, for example: `sudo apt install nmap iproute2`. Run the app as your normal user; no sudo is used by the discovery job.
- Export your current work, stop the launcher, then restart `./dev-start.sh`. The Bash launcher enables discovery with `NETWORK_LAB_DISCOVERY=1` and binds Flask/Vite to localhost. If it skips an already-running backend, stop that backend and restart so it picks up the new feature flag.
- Choose **Discover local network** in the header or Inventory workspace. Opening the panel reads local interface addresses and configured gateways; it does not start Nmap. Select an active interface, review the CIDR range, then click **Start discovery**.
- Discovery supports directly connected RFC1918 IPv4 networks with at most 256 selected addresses. For a larger connected subnet, the suggested range is a /24 containing this computer's IP; choose another smaller range within that connected subnet if needed. Public, off-link, IPv6, virtual/VPN interfaces, and more-specific redirecting routes are outside this milestone. Custom policy rules do not automatically disable discovery: before probing, the worker verifies the kernel route for every usable address in the selected range. Redirected, gateway-routed, unreachable, or down-link destinations fail before Nmap starts. These route lookups send no discovery probes and remain cancellable.
- The fixed Nmap job uses `--unprivileged -sn -n -T3 --max-retries 1 --host-timeout 5s --max-rate 32 -oX - <CIDR>`. This is host discovery without a subsequent port scan, scripts, OS fingerprinting, or DNS lookup. Nmap may use TCP connection probes as part of discovering hosts. Some devices will not respond. Traffic follows the computer's OS routing; do not change network/VPN settings during discovery.
- Jobs show elapsed time and status, allow **Cancel discovery**, and time out after 120 seconds. Only one job can run at a time. Closing the panel cancels a running job. Reopening can resume an active job or recover a recent completed result; completed results expire after 15 minutes, when displaced by newer jobs, or when the backend restarts.
- Click **Review discovered hosts** after completion. The normal Nmap review still applies: choose assets and identity matches before importing anything. The lab topology is not modified. Imported observations include the scanner interface/scope and configured gateway; these are facts about the scanning computer, not each discovered device's own subnet mask or gateway.
- MAC addresses may come from the Linux neighbor cache when Nmap does not report them. Such records explicitly identify that source and may be cached. Device types remain unconfirmed, and no service inventory is fabricated by a host-only discovery job. Import a more detailed existing Nmap XML file if you need port or OS evidence.
- No actual LAN scan was used in automated verification. Backend tests and browser workflow checks use fixture interfaces and a fake scanner, including cancellation and timeout behavior. Test actual reachability through the UI on your own selected LAN.
- Discovery endpoints are disabled unless explicitly enabled. Enabled endpoints require a loopback client/Host, an allowed local browser origin, and a per-process session token for jobs. Tokens stay in browser memory. The Render configuration does not enable discovery, and the hosted backend does not scan the visitor's LAN.
- For manual local startup: `NETWORK_LAB_DISCOVERY=1 .venv/bin/python backend/app.py`. Use one local backend process. Docker/Render, Windows, and macOS users can continue using XML import for this milestone. Discovery jobs and results are memory-only; review/import results and export JSON to retain them.

Discovery behavior reference: [Nmap host discovery documentation](https://nmap.org/book/man-host-discovery.html).
