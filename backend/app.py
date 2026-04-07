
from flask import Flask, request, jsonify
from flask_cors import CORS
import random
import math
import ipaddress
from collections import deque

NON_PINGABLE_TYPES = {
    "usb-storage",
    "usb-keyboard",
    "usb-mouse",
    "usb-webcam",
    "usb-audio",
    "usb-printer",
    "beacon",
    "sensor",
    "iot-tag",
}

FORWARDING_TYPES = {"switch", "router", "gateway"}

app = Flask(__name__)
CORS(app)


def make_mac():
    return ":".join(f"{random.randint(0,255):02x}" for _ in range(6))


def stable_mac_from_seed(seed):
    text = str(seed or "0")
    hashed = 2166136261
    for char in text:
        hashed ^= ord(char)
        hashed = (hashed * 16777619) & 0xFFFFFFFF
    bytes_out = [0x02, 0x00, 0x00, (hashed >> 16) & 0xFF, (hashed >> 8) & 0xFF, hashed & 0xFF]
    return ":".join(f"{byte:02x}" for byte in bytes_out)


def normalize_mac(value):
    text = str(value or "").strip().lower()
    parts = text.split(":")
    if len(parts) != 6:
        return None
    if any(len(part) != 2 for part in parts):
        return None
    try:
        [int(part, 16) for part in parts]
    except ValueError:
        return None
    return text


def device_mac(device):
    normalized = normalize_mac(device.get("mac") if device else None)
    if normalized:
        return normalized
    if not device:
        return stable_mac_from_seed("none")
    return stable_mac_from_seed(device.get("id") or device.get("name") or "device")


def is_switch(device):
    return str((device or {}).get("type") or "").lower() == "switch"


def switch_port_id(switch_id, neighbor_id):
    return f"link-{switch_id}-{neighbor_id}"


def parse_switch_port_neighbor(port_id, switch_id):
    prefix = f"link-{switch_id}-"
    text = str(port_id or "")
    if not text.startswith(prefix):
        return None
    return text[len(prefix):]


def switch_neighbors(switch_id, connections):
    switch_id = str(switch_id)
    neighbors = []
    for conn in connections:
        conn_from = str(conn.get("from"))
        conn_to = str(conn.get("to"))
        if conn_from == switch_id and can_traverse(conn, switch_id, conn_to):
            neighbors.append(conn_to)
        elif conn_to == switch_id and can_traverse(conn, switch_id, conn_from):
            neighbors.append(conn_from)
    return neighbors


def build_switch_mac_tables(devices):
    tables = {}
    for device in devices:
        if not is_switch(device):
            continue
        switch_id = str(device.get("id"))
        raw_table = device.get("mac_table") or {}
        table = {}
        for mac_addr, port in raw_table.items():
            normalized_mac = normalize_mac(mac_addr)
            if normalized_mac and port:
                table[normalized_mac] = str(port)
        tables[switch_id] = table
    return tables


def build_arp_tables(devices):
    tables = {}
    for device in devices:
        device_id = str(device.get("id"))
        raw_table = device.get("arp_table") or {}
        table = {}
        for ip_addr, mac_addr in raw_table.items():
            ip = str(ip_addr or "").strip()
            mac = normalize_mac(mac_addr)
            if ip and mac:
                table[ip] = mac
        tables[device_id] = table
    return tables


def parse_ping_count(parts):
    count = 4
    for index, part in enumerate(parts):
        if part == "-c" and index + 1 < len(parts):
            try:
                count = int(parts[index + 1])
            except ValueError:
                pass
        elif part.startswith("-c") and len(part) > 2:
            try:
                count = int(part[2:])
            except ValueError:
                pass
    return max(1, min(count, 20))


def find_device_by_token(devices, token):
    normalized = str(token or "").strip().lower()
    if not normalized:
        return None
    for device in devices:
        if str(device.get("id", "")).lower() == normalized:
            return device
        if str(device.get("name", "")).lower() == normalized:
            return device
        if str(device.get("ip", "")).lower() == normalized:
            return device
    return None


def is_ping_capable(device):
    if not device:
        return False
    device_type = str(device.get("type") or "").lower()
    if device_type in NON_PINGABLE_TYPES:
        return False
    return True


def is_forwarding_device(device):
    if not device:
        return False
    return str(device.get("type") or "").lower() in FORWARDING_TYPES


def parse_ipv4_address(value):
    text = str(value).strip() if value is not None else ""
    if not text:
        return None
    try:
        if "/" in text:
            return ipaddress.ip_interface(text).ip
        return ipaddress.ip_address(text)
    except Exception:
        return None


def parse_ipv4_network(value):
    try:
        return ipaddress.ip_network(str(value).strip(), strict=False)
    except Exception:
        return None


def connected_network_for_device(device):
    if not device:
        return None
    raw_ip = str(device.get("ip") or "").strip()
    if not raw_ip:
        return None
    try:
        if "/" in raw_ip:
            return ipaddress.ip_interface(raw_ip).network
        ip = ipaddress.ip_address(raw_ip)
        return ipaddress.ip_network(f"{ip}/24", strict=False)
    except Exception:
        return None


def select_best_route(source, target_ip):
    target_addr = parse_ipv4_address(target_ip)
    if not source or not target_addr:
        return None

    static_candidates = []
    default_candidates = []
    for route in source.get("routes", []) or []:
        network = parse_ipv4_network(route.get("network"))
        via = route.get("via")
        via_addr = parse_ipv4_address(via)
        if not network or not via_addr:
            continue
        candidate = {
            "kind": "static",
            "network": str(network),
            "via": str(via_addr),
            "prefix": network.prefixlen,
        }
        if network.prefixlen == 0:
            default_candidates.append(candidate)
            continue
        if target_addr in network:
            static_candidates.append(candidate)

    if static_candidates:
        static_candidates.sort(key=lambda item: item["prefix"], reverse=True)
        return static_candidates[0]

    connected_net = connected_network_for_device(source)
    if connected_net and target_addr in connected_net:
        return {
            "kind": "connected",
            "network": str(connected_net),
            "via": "DIRECT",
            "prefix": connected_net.prefixlen,
        }

    if default_candidates:
        return default_candidates[0]

    return None


def build_path_for_route(source, target, selected_route, devices, connections, devices_by_id):
    if not source or not target:
        return None, "missing source or target"

    source_id = str(source.get("id"))
    target_id = str(target.get("id"))
    device_ids = [str(device.get("id")) for device in devices if device.get("id") is not None]

    if not selected_route:
        return None, "no matching route"

    if not selected_route.get("via"):
        direct_path = find_path(
            device_ids=device_ids,
            connections=connections,
            start_id=source_id,
            target_id=target_id,
            devices_by_id=devices_by_id,
        )
        return direct_path, None if direct_path else "no route in topology"

    gateway_ip = selected_route.get("via")
    gateway = next((device for device in devices if str(device.get("ip") or "") == str(gateway_ip)), None)
    if not gateway:
        return None, f"gateway {gateway_ip} not found"

    gateway_id = str(gateway.get("id"))
    to_gateway = find_path(
        device_ids=device_ids,
        connections=connections,
        start_id=source_id,
        target_id=gateway_id,
        devices_by_id=devices_by_id,
    )
    if not to_gateway:
        return None, f"gateway {gateway_ip} unreachable"

    if gateway_id == target_id:
        return to_gateway, None

    to_target = find_path(
        device_ids=device_ids,
        connections=connections,
        start_id=gateway_id,
        target_id=target_id,
        devices_by_id=devices_by_id,
    )
    if not to_target:
        return None, "no route from gateway to target"

    return to_gateway + to_target[1:], None


def has_static_routes(device):
    if not device:
        return False
    for route in device.get("routes", []) or []:
        if parse_ipv4_network(route.get("network")) and parse_ipv4_address(route.get("via")):
            return True
    return False


def can_traverse(conn, src_id, dst_id):
    direction = (conn.get("direction") or "both").lower()
    conn_from = str(conn.get("from"))
    conn_to = str(conn.get("to"))
    src_id = str(src_id)
    dst_id = str(dst_id)

    if conn_from == src_id and conn_to == dst_id:
        return direction in ("both", "forward")
    if conn_from == dst_id and conn_to == src_id:
        return direction in ("both", "reverse")
    return False


def find_path(device_ids, connections, start_id, target_id, devices_by_id):
    start_id = str(start_id)
    target_id = str(target_id)
    if start_id == target_id:
        return [start_id]

    graph = {str(device_id): [] for device_id in device_ids}

    for conn in connections:
        conn_from = str(conn.get("from"))
        conn_to = str(conn.get("to"))
        if conn_from not in graph or conn_to not in graph:
            continue
        if can_traverse(conn, conn_from, conn_to):
            graph[conn_from].append(conn_to)
        if can_traverse(conn, conn_to, conn_from):
            graph[conn_to].append(conn_from)

    queue = deque([start_id])
    parent = {start_id: None}

    while queue:
        current = queue.popleft()
        if current == target_id:
            break

        if current != start_id and current != target_id and not is_forwarding_device(devices_by_id.get(current)):
            continue

        for neighbor in graph.get(current, []):
            if neighbor in parent:
                continue
            parent[neighbor] = current
            queue.append(neighbor)

    if target_id not in parent:
        return None

    path = []
    cursor = target_id
    while cursor is not None:
        path.append(cursor)
        cursor = parent[cursor]
    path.reverse()
    return path


@app.route("/api/run-command", methods=["POST"])
def run_command():
    data = request.json
    command = (data.get("command") or "").strip()
    devices = data.get("devices", [])
    connections = data.get("connections", [])
    source_device_id = str(data.get("sourceDeviceId")) if data.get("sourceDeviceId") is not None else None

    parts = command.split()
    packets = []
    output_lines = []
    pkt_counter = [0]
    device_updates = []

    def next_no():
        pkt_counter[0] += 1
        return pkt_counter[0]

    def respond(lines, out_packets, updates=None):
        return jsonify({
            "output": lines,
            "packets": out_packets,
            "deviceUpdates": updates or [],
        })

    if not parts:
        return respond([""], [])

    cmd = parts[0].lower()

    if cmd == "ping" and len(parts) >= 2:
        target_token = parts[1]
        count = parse_ping_count(parts)
        devices_by_id = {str(device.get("id")): device for device in devices}
        target_device = find_device_by_token(devices, target_token)

        ip_devices = [d for d in devices if d.get("ip")]
        source = None
        if source_device_id:
            source = devices_by_id.get(source_device_id)

        if source and not is_ping_capable(source):
            output_lines = [
                f"ping: source '{source.get('name')}' does not support ICMP/IP",
                "hint: start ping from an IP-capable host (pc/server/router/gateway/laptop/phone)",
            ]
            return respond(output_lines, [])

        if source and not source.get("ip"):
            output_lines = [f"ping: source '{source.get('name')}' has no IP configured"]
            return respond(output_lines, [])

        target = target_device if target_device and target_device.get("ip") else None
        target_ip = target.get("ip") if target else target_token

        if target_device and not is_ping_capable(target_device):
            output_lines = [
                f"PING {target_device.get('name')} ({target_token}) 56(84) bytes of data.",
                f"ping: {target_device.get('name')}: target is a peripheral/non-IP endpoint",
                "",
                f"--- {target_device.get('name')} ping statistics ---",
                f"{count} packets transmitted, 0 received, 100% packet loss, time {count * 1000}ms",
            ]
            return respond(output_lines, [])

        if target_device and not target_device.get("ip"):
            output_lines = [
                f"PING {target_device.get('name')} ({target_token}) 56(84) bytes of data.",
                f"ping: {target_device.get('name')}: target has no IP configured",
                "",
                f"--- {target_device.get('name')} ping statistics ---",
                f"{count} packets transmitted, 0 received, 100% packet loss, time {count * 1000}ms",
            ]
            return respond(output_lines, [])

        if not source:
            if target:
                source = next((d for d in ip_devices if d.get("ip") != target_ip), None)
            if not source:
                source = ip_devices[0] if ip_devices else None

        if target and source and source.get("ip") == target_ip:
            alt_source = next((d for d in ip_devices if d.get("ip") != target_ip), None)
            if alt_source:
                source = alt_source

        src_ip = source["ip"] if source else "192.168.1.1"
        src_mac = device_mac(source)
        dst_mac = device_mac(target) if target else stable_mac_from_seed(target_ip)
        switch_mac_tables = build_switch_mac_tables(devices)
        arp_tables = build_arp_tables(devices)

        output_lines.append(f"PING {target_ip} ({target_ip}) 56(84) bytes of data.")

        if target:
            selected_route = select_best_route(source, target_ip)
            path = None
            route_error = None
            if selected_route:
                path, route_error = build_path_for_route(source, target, selected_route, devices, connections, devices_by_id)
            elif has_static_routes(source):
                route_error = "no matching route"
            else:
                path = find_path(
                    device_ids=[str(device.get("id")) for device in devices if device.get("id") is not None],
                    connections=connections,
                    start_id=str(source.get("id")) if source else "",
                    target_id=str(target.get("id")),
                    devices_by_id=devices_by_id,
                )
                if not path:
                    route_error = "no route in topology"

            if selected_route:
                if selected_route.get("via"):
                    output_lines.append(f"Route match: {selected_route.get('network')} via {selected_route.get('via')}")
                    if str(selected_route.get("network")) == "0.0.0.0/0":
                        output_lines.append(f"Using default gateway {selected_route.get('via')}")
                else:
                        output_lines.append(f"Route match: {selected_route.get('network')} via DIRECT")
                packets.append({
                    "no": next_no(), "time": 0.0,
                    "src": source.get("ip") or source.get("name") or src_ip,
                    "dst": target_ip,
                    "protocol": "ROUTE", "len": 64,
                    "info": f"Route match: {selected_route.get('network')} via {selected_route.get('via') or 'DIRECT'}"
                })

            if not path:
                output_lines += [
                    "Destination unreachable:",
                    f"{route_error or 'no matching route'}",
                    "",
                    f"--- {target_ip} ping statistics ---",
                    f"{count} packets transmitted, 0 received, 100% packet loss, time {count * 1000}ms",
                ]
                device_updates = [
                    {"id": switch_id, "mac_table": table}
                    for switch_id, table in switch_mac_tables.items()
                ] + [
                    {"id": device_id, "arp_table": table}
                    for device_id, table in arp_tables.items()
                    if table
                ]
                return respond(output_lines, packets, device_updates)

            hop_names = [devices_by_id.get(path_id, {}).get("name", path_id) for path_id in path]
            output_lines.append(f"route: {' -> '.join(hop_names)}")

            def append_frame_hop(from_id, to_id, hop_time, protocol, frame_info, frame_src_mac, frame_dst_mac, frame_len=74):
                hop_from = devices_by_id.get(from_id, {})
                hop_to = devices_by_id.get(to_id, {})
                packets.append({
                    "no": next_no(), "time": hop_time,
                    "src": hop_from.get("ip") or hop_from.get("name") or src_ip,
                    "dst": hop_to.get("ip") or hop_to.get("name") or target_ip,
                    "protocol": protocol, "len": frame_len,
                    "src_mac": frame_src_mac,
                    "dst_mac": frame_dst_mac,
                    "ingress_port": switch_port_id(to_id, from_id) if is_switch(hop_to) else None,
                    "egress_port": switch_port_id(from_id, to_id) if is_switch(hop_from) else None,
                    "info": frame_info,
                })

            def process_switch_forwarding(switch_id, ingress_id, intended_next_id, frame_src_mac, frame_dst_mac, event_time, seq, frame_protocol="ICMP", frame_replica_info=None, force_flood=False):
                switch_device = devices_by_id.get(switch_id, {})
                switch_name = switch_device.get("name") or switch_id
                ingress_port = switch_port_id(switch_id, ingress_id)
                table = switch_mac_tables.setdefault(str(switch_id), {})
                learned = table.get(frame_src_mac) != ingress_port
                table[frame_src_mac] = ingress_port
                if learned:
                    packets.append({
                        "no": next_no(),
                        "time": round(event_time + 0.0001, 4),
                        "src": switch_name,
                        "dst": "l2-control",
                        "protocol": "L2",
                        "len": 64,
                        "src_mac": frame_src_mac,
                        "dst_mac": frame_dst_mac,
                        "ingress_port": ingress_port,
                        "egress_port": None,
                        "info": f"Switch-{switch_name} learned MAC {frame_src_mac} on {ingress_port}",
                    })

                is_broadcast = str(frame_dst_mac).lower() == "ff:ff:ff:ff:ff:ff"
                known_port = table.get(frame_dst_mac)
                neighbors = switch_neighbors(switch_id, connections)
                egress_ids = []
                flood_mode = False
                if force_flood or is_broadcast:
                    flood_mode = True
                elif known_port:
                    known_neighbor = parse_switch_port_neighbor(known_port, switch_id)
                    if known_neighbor and known_neighbor in neighbors and known_neighbor != str(ingress_id):
                        egress_ids = [known_neighbor]
                        packets.append({
                            "no": next_no(),
                            "time": round(event_time + 0.00015, 4),
                            "src": switch_name,
                            "dst": known_neighbor,
                            "protocol": "L2",
                            "len": 64,
                            "src_mac": frame_src_mac,
                            "dst_mac": frame_dst_mac,
                            "ingress_port": ingress_port,
                            "egress_port": known_port,
                            "info": f"Switch-{switch_name} forwarding frame to {known_port}",
                        })
                    else:
                        flood_mode = True
                else:
                    flood_mode = True

                if flood_mode:
                    egress_ids = [neighbor for neighbor in neighbors if neighbor != str(ingress_id)]
                    packets.append({
                        "no": next_no(),
                        "time": round(event_time + 0.0002, 4),
                        "src": switch_name,
                        "dst": "ff:ff:ff:ff:ff:ff",
                        "protocol": "L2",
                        "len": 64,
                        "src_mac": frame_src_mac,
                        "dst_mac": frame_dst_mac,
                        "ingress_port": ingress_port,
                        "egress_port": "FLOOD",
                        "info": f"Switch-{switch_name} flooding frame (unknown destination MAC)",
                    })

                    for flood_neighbor in egress_ids:
                        if str(flood_neighbor) == str(intended_next_id):
                            continue
                        flood_neighbor_device = devices_by_id.get(str(flood_neighbor), {})
                        packets.append({
                            "no": next_no(),
                            "time": round(event_time + 0.0004, 4),
                            "src": switch_name,
                            "dst": flood_neighbor_device.get("ip") or flood_neighbor_device.get("name") or flood_neighbor,
                            "protocol": frame_protocol,
                            "len": 74,
                            "src_mac": frame_src_mac,
                            "dst_mac": frame_dst_mac,
                            "ingress_port": ingress_port,
                            "egress_port": switch_port_id(switch_id, flood_neighbor),
                            "info": frame_replica_info or f"Switch flood replica seq={seq}/256",
                        })

                return str(intended_next_id) in {str(egress) for egress in egress_ids}

            source_id = str(source.get("id")) if source else None
            target_id = str(target.get("id")) if target else None
            source_arp_table = arp_tables.setdefault(source_id, {}) if source_id else {}
            target_arp_table = arp_tables.setdefault(target_id, {}) if target_id else {}
            cached_dst_mac = normalize_mac(source_arp_table.get(target_ip))
            resolved_dst_mac = cached_dst_mac if cached_dst_mac else dst_mac

            if not cached_dst_mac:
                output_lines.append(f"ARP request broadcast for {target_ip}")
                request_hops = max(1, len(path) - 1)
                for hop_index in range(request_hops):
                    from_id = path[hop_index]
                    to_id = path[hop_index + 1]
                    hop_time = round(0.0008 + hop_index * 0.0012, 4)
                    append_frame_hop(
                        from_id,
                        to_id,
                        hop_time,
                        "ARP",
                        f"ARP request broadcast for {target_ip}",
                        src_mac,
                        "ff:ff:ff:ff:ff:ff",
                        42,
                    )
                    if is_switch(devices_by_id.get(to_id)) and hop_index + 2 < len(path):
                        intended_next = path[hop_index + 2]
                        process_switch_forwarding(
                            to_id,
                            from_id,
                            intended_next,
                            src_mac,
                            "ff:ff:ff:ff:ff:ff",
                            hop_time,
                            seq=0,
                            frame_protocol="ARP",
                            frame_replica_info=f"ARP request broadcast for {target_ip}",
                            force_flood=True,
                        )

                target_arp_table[src_ip] = src_mac
                output_lines.append(f"ARP reply from {target_ip} ({dst_mac})")

                reverse_path = list(reversed(path))
                reply_hops = max(1, len(reverse_path) - 1)
                arp_reply_delivered = True
                for hop_index in range(reply_hops):
                    from_id = reverse_path[hop_index]
                    to_id = reverse_path[hop_index + 1]
                    hop_time = round(0.006 + hop_index * 0.0012, 4)
                    append_frame_hop(
                        from_id,
                        to_id,
                        hop_time,
                        "ARP",
                        f"ARP reply from {target_ip} ({dst_mac})",
                        dst_mac,
                        src_mac,
                        42,
                    )
                    if is_switch(devices_by_id.get(to_id)) and hop_index + 2 < len(reverse_path):
                        intended_next = reverse_path[hop_index + 2]
                        if not process_switch_forwarding(
                            to_id,
                            from_id,
                            intended_next,
                            dst_mac,
                            src_mac,
                            hop_time,
                            seq=0,
                            frame_protocol="ARP",
                            frame_replica_info=f"ARP reply unicast for {src_ip}",
                            force_flood=False,
                        ):
                            arp_reply_delivered = False
                            break

                if arp_reply_delivered:
                    source_arp_table[target_ip] = dst_mac
                    output_lines.append(f"ARP table updated: {target_ip} -> {dst_mac}")
                    resolved_dst_mac = dst_mac
                else:
                    output_lines.append(f"ARP resolution failed for {target_ip}")
                    output_lines += [
                        "",
                        f"--- {target_ip} ping statistics ---",
                        f"{count} packets transmitted, 0 received, 100% packet loss, time {count * 1000}ms",
                    ]
                    device_updates = [
                        {"id": switch_id, "mac_table": table}
                        for switch_id, table in switch_mac_tables.items()
                    ] + [
                        {"id": device_id, "arp_table": table}
                        for device_id, table in arp_tables.items()
                        if table
                    ]
                    return respond(output_lines, packets, device_updates)
            else:
                output_lines.append(f"ARP table updated: {target_ip} -> {cached_dst_mac}")

            rtt_samples = []
            successful_rtts = []
            for seq in range(1, count + 1):
                base = round(seq * 0.05 + random.uniform(0, 0.005), 4)
                rtt_ms = round(random.uniform(0.4, 2.5), 2)
                rtt_samples.append(rtt_ms)

                request_hops = max(1, len(path) - 1)
                request_delivered = True
                for hop_index in range(request_hops):
                    from_id = path[hop_index]
                    to_id = path[hop_index + 1]
                    hop_time = round(base + hop_index * 0.0015, 4)
                    append_frame_hop(
                        from_id,
                        to_id,
                        hop_time,
                        "ICMP",
                        f"ICMP echo request sent: seq={seq}/256 ttl={max(1, 64 - hop_index)} hop {hop_index + 1}/{request_hops}",
                        src_mac,
                        resolved_dst_mac,
                        74,
                    )

                    if is_switch(devices_by_id.get(to_id)) and hop_index + 2 < len(path):
                        intended_next = path[hop_index + 2]
                        if not process_switch_forwarding(to_id, from_id, intended_next, src_mac, resolved_dst_mac, hop_time, seq):
                            request_delivered = False
                            packets.append({
                                "no": next_no(),
                                "time": round(hop_time + 0.0006, 4),
                                "src": devices_by_id.get(to_id, {}).get("name") or to_id,
                                "dst": "l2-control",
                                "protocol": "L2",
                                "len": 64,
                                "src_mac": src_mac,
                                "dst_mac": resolved_dst_mac,
                                "ingress_port": switch_port_id(to_id, from_id),
                                "egress_port": None,
                                "info": "Switch drop: destination MAC not reachable on active ports",
                            })
                            break

                if not request_delivered:
                    output_lines.append(f"Destination unreachable: layer2 forwarding failure for icmp_seq={seq}")
                    continue

                reverse_path = list(reversed(path))
                reply_hops = max(1, len(reverse_path) - 1)
                reply_delivered = True
                for hop_index in range(reply_hops):
                    from_id = reverse_path[hop_index]
                    to_id = reverse_path[hop_index + 1]
                    hop_time = round(base + rtt_ms / 1000 + hop_index * 0.0015, 4)
                    append_frame_hop(
                        from_id,
                        to_id,
                        hop_time,
                        "ICMP",
                        f"ICMP echo reply received: seq={seq}/256 ttl={max(1, 64 - hop_index)} hop {hop_index + 1}/{reply_hops}",
                        dst_mac,
                        src_mac,
                        74,
                    )

                    if is_switch(devices_by_id.get(to_id)) and hop_index + 2 < len(reverse_path):
                        intended_next = reverse_path[hop_index + 2]
                        if not process_switch_forwarding(to_id, from_id, intended_next, dst_mac, src_mac, hop_time, seq):
                            reply_delivered = False
                            packets.append({
                                "no": next_no(),
                                "time": round(hop_time + 0.0006, 4),
                                "src": devices_by_id.get(to_id, {}).get("name") or to_id,
                                "dst": "l2-control",
                                "protocol": "L2",
                                "len": 64,
                                "src_mac": dst_mac,
                                "dst_mac": src_mac,
                                "ingress_port": switch_port_id(to_id, from_id),
                                "egress_port": None,
                                "info": "Switch drop: destination MAC not reachable on active ports",
                            })
                            break

                if reply_delivered:
                    successful_rtts.append(rtt_ms)
                    output_lines.append(
                        f"64 bytes from {target_ip}: icmp_seq={seq} ttl=64 time={rtt_ms:.2f} ms"
                    )
                else:
                    output_lines.append(f"Destination unreachable: layer2 forwarding failure for icmp_seq={seq}")

            received_count = len(successful_rtts)
            output_lines += [
                "",
                f"--- {target_ip} ping statistics ---",
                f"{count} packets transmitted, {received_count} received, {round((1 - (received_count / count)) * 100)}% packet loss, time {count * 1000}ms",
            ]
            if successful_rtts:
                avg_rtt = sum(successful_rtts) / len(successful_rtts)
                variance = sum((value - avg_rtt) ** 2 for value in successful_rtts) / len(successful_rtts)
                mdev = math.sqrt(variance)
                output_lines.append(
                    f"rtt min/avg/max/mdev = {min(successful_rtts):.3f}/{avg_rtt:.3f}/{max(successful_rtts):.3f}/{mdev:.3f} ms"
                )
        else:
            # Target not on network — ARP timeouts
            for seq in range(1, count + 1):
                t = round(seq * 1.002, 3)
                packets.append({
                    "no": next_no(), "time": t,
                    "src": src_mac, "dst": "ff:ff:ff:ff:ff:ff",
                    "protocol": "ARP", "len": 42,
                    "info": f"ARP request broadcast for {target_ip}"
                })
                output_lines.append(
                    "Destination unreachable:"
                )
                output_lines.append("no matching route")

            output_lines += [
                "",
                f"--- {target_ip} ping statistics ---",
                f"{count} packets transmitted, 0 received, 100% packet loss, time {count * 1000}ms",
            ]

        device_updates = [
            {"id": switch_id, "mac_table": table}
            for switch_id, table in switch_mac_tables.items()
        ] + [
            {"id": device_id, "arp_table": table}
            for device_id, table in arp_tables.items()
            if table
        ]

    elif cmd == "traceroute" and len(parts) >= 2:
        target_token = parts[1]
        devices_by_id = {str(device.get("id")): device for device in devices}
        target_device = find_device_by_token(devices, target_token)

        if not target_device or not target_device.get("ip"):
            output_lines = [f"traceroute: unknown host {target_token}"]
            return respond(output_lines, [])

        source = devices_by_id.get(source_device_id) if source_device_id else None
        if not source:
            source = next((device for device in devices if device.get("ip") and str(device.get("id")) != str(target_device.get("id"))), None)

        if not source:
            output_lines = ["traceroute: no suitable source host"]
            return respond(output_lines, [])

        if not source.get("ip"):
            output_lines = [f"traceroute: source '{source.get('name')}' has no IP configured"]
            return respond(output_lines, [])

        target_ip = target_device.get("ip")
        selected_route = select_best_route(source, target_ip)
        path = None
        route_error = None
        if selected_route:
            path, route_error = build_path_for_route(source, target_device, selected_route, devices, connections, devices_by_id)
        elif has_static_routes(source):
            route_error = "no matching route"
        else:
            path = find_path(
                device_ids=[str(device.get("id")) for device in devices if device.get("id") is not None],
                connections=connections,
                start_id=str(source.get("id")),
                target_id=str(target_device.get("id")),
                devices_by_id=devices_by_id,
            )
            if not path:
                route_error = "no route in topology"

        output_lines.append(f"traceroute to {target_device.get('name')} ({target_ip}), max 30 hops")
        if selected_route:
            if selected_route.get("via"):
                output_lines.append(f"Route match: {selected_route.get('network')} via {selected_route.get('via')}")
                if str(selected_route.get("network")) == "0.0.0.0/0":
                    output_lines.append(f"Using default gateway {selected_route.get('via')}")
            else:
                output_lines.append(f"Route match: {selected_route.get('network')} via DIRECT")
        elif has_static_routes(source):
            output_lines.append("Destination unreachable:")
            output_lines.append("no matching route")
        else:
            output_lines.append("Route match: topology path fallback")

        if not path:
            output_lines.append(f"traceroute: destination unreachable ({route_error or 'no route in topology'})")
            return respond(output_lines, [])

        hop_count = max(1, len(path) - 1)
        for hop in range(1, hop_count + 1):
            hop_device = devices_by_id.get(path[hop], {})
            hop_name = hop_device.get("name") or path[hop]
            hop_ip = hop_device.get("ip") or hop_name
            hop_latency = round(0.7 + hop * 0.8 + random.uniform(0, 0.25), 2)

            output_lines.append(f" {hop:<2} {hop_name} ({hop_ip})  {hop_latency:.2f} ms")

            packets.append({
                "no": next_no(),
                "time": round(hop * 0.01, 4),
                "src": source.get("ip") or source.get("name"),
                "dst": hop_ip,
                "protocol": "ICMP",
                "len": 74,
                "info": f"Traceroute probe ttl={hop} hop {hop}/{hop_count}"
            })

            if hop < hop_count:
                packets.append({
                    "no": next_no(),
                    "time": round(hop * 0.01 + 0.003, 4),
                    "src": hop_ip,
                    "dst": source.get("ip") or source.get("name"),
                    "protocol": "ICMP",
                    "len": 70,
                    "info": f"ICMP Time Exceeded ttl={hop} from {hop_name}"
                })
            else:
                packets.append({
                    "no": next_no(),
                    "time": round(hop * 0.01 + 0.004, 4),
                    "src": hop_ip,
                    "dst": source.get("ip") or source.get("name"),
                    "protocol": "ICMP",
                    "len": 70,
                    "info": f"ICMP Echo Reply from {hop_name}"
                })

    elif cmd == "help":
        output_lines = [
            "Available commands:",
            "  ping <ip> [-c N]  - send ICMP echo requests",
            "  traceroute <ip>   - trace route hop-by-hop",
            "  help              - show available commands",
            "  clear             - clear terminal output",
        ]
    else:
        output_lines = [f"bash: {cmd}: command not found"]

    return respond(output_lines, packets, device_updates)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
