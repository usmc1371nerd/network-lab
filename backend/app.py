
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
    try:
        return ipaddress.ip_address(str(value).strip())
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
    ip = parse_ipv4_address(device.get("ip"))
    if not ip:
        return None
    return ipaddress.ip_network(f"{ip}/24", strict=False)


def select_best_route(source, target_ip):
    target_addr = parse_ipv4_address(target_ip)
    if not source or not target_addr:
        return None

    connected_net = connected_network_for_device(source)
    if connected_net and target_addr in connected_net:
        return {
            "kind": "connected",
            "network": str(connected_net),
            "via": None,
            "prefix": connected_net.prefixlen,
        }

    candidates = []
    for route in source.get("routes", []) or []:
        network = parse_ipv4_network(route.get("network"))
        via = route.get("via")
        via_addr = parse_ipv4_address(via)
        if not network or not via_addr:
            continue
        if target_addr in network:
            candidates.append({
                "kind": "static",
                "network": str(network),
                "via": str(via_addr),
                "prefix": network.prefixlen,
            })

    if not candidates:
        return None
    candidates.sort(key=lambda item: item["prefix"], reverse=True)
    return candidates[0]


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

    def next_no():
        pkt_counter[0] += 1
        return pkt_counter[0]

    if not parts:
        return jsonify({"output": [""], "packets": []})

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
            return jsonify({"output": output_lines, "packets": []})

        if source and not source.get("ip"):
            output_lines = [f"ping: source '{source.get('name')}' has no IP configured"]
            return jsonify({"output": output_lines, "packets": []})

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
            return jsonify({"output": output_lines, "packets": []})

        if target_device and not target_device.get("ip"):
            output_lines = [
                f"PING {target_device.get('name')} ({target_token}) 56(84) bytes of data.",
                f"ping: {target_device.get('name')}: target has no IP configured",
                "",
                f"--- {target_device.get('name')} ping statistics ---",
                f"{count} packets transmitted, 0 received, 100% packet loss, time {count * 1000}ms",
            ]
            return jsonify({"output": output_lines, "packets": []})

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
        src_mac = make_mac()
        dst_mac = make_mac()

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
                    output_lines.append(
                        f"route lookup: {target_ip} matched {selected_route.get('network')} via {selected_route.get('via')}"
                    )
                else:
                    output_lines.append(
                        f"route lookup: {target_ip} matched connected {selected_route.get('network')}"
                    )
                packets.append({
                    "no": next_no(), "time": 0.0,
                    "src": source.get("ip") or source.get("name") or src_ip,
                    "dst": target_ip,
                    "protocol": "ROUTE", "len": 64,
                    "info": f"route decision {selected_route.get('network')} via {selected_route.get('via') or 'connected'}"
                })

            if not path:
                output_lines += [
                    f"From {src_ip} Destination Host Unreachable ({route_error or 'no route in topology'})",
                    "",
                    f"--- {target_ip} ping statistics ---",
                    f"{count} packets transmitted, 0 received, 100% packet loss, time {count * 1000}ms",
                ]
                return jsonify({"output": output_lines, "packets": packets})

            hop_names = [devices_by_id.get(path_id, {}).get("name", path_id) for path_id in path]
            output_lines.append(f"route: {' -> '.join(hop_names)}")

            # ARP resolution
            first_hop_device = devices_by_id.get(path[1], target) if len(path) > 1 else target
            first_hop_ip = first_hop_device.get("ip") or target_ip
            packets.append({
                "no": next_no(), "time": 0.0,
                "src": src_mac, "dst": "ff:ff:ff:ff:ff:ff",
                "protocol": "ARP", "len": 42,
                "info": f"Who has {first_hop_ip}?  Tell {src_ip}"
            })
            packets.append({
                "no": next_no(), "time": round(random.uniform(0.0005, 0.002), 4),
                "src": dst_mac, "dst": src_mac,
                "protocol": "ARP", "len": 42,
                "info": f"{first_hop_ip} is at {dst_mac}"
            })

            rtt_samples = []
            for seq in range(1, count + 1):
                base = round(seq * 0.05 + random.uniform(0, 0.005), 4)
                rtt_ms = round(random.uniform(0.4, 2.5), 2)
                rtt_samples.append(rtt_ms)

                request_hops = max(1, len(path) - 1)
                for hop_index in range(request_hops):
                    hop_from = devices_by_id.get(path[hop_index], {})
                    hop_to = devices_by_id.get(path[hop_index + 1], {})
                    hop_time = round(base + hop_index * 0.0015, 4)
                    packets.append({
                        "no": next_no(), "time": hop_time,
                        "src": hop_from.get("ip") or hop_from.get("name") or src_ip,
                        "dst": hop_to.get("ip") or hop_to.get("name") or target_ip,
                        "protocol": "ICMP", "len": 74,
                        "info": f"Echo (ping) request  id=0x0001, seq={seq}/256, ttl={max(1, 64 - hop_index)} hop {hop_index + 1}/{request_hops}"
                    })

                reverse_path = list(reversed(path))
                reply_hops = max(1, len(reverse_path) - 1)
                for hop_index in range(reply_hops):
                    hop_from = devices_by_id.get(reverse_path[hop_index], {})
                    hop_to = devices_by_id.get(reverse_path[hop_index + 1], {})
                    hop_time = round(base + rtt_ms / 1000 + hop_index * 0.0015, 4)
                    packets.append({
                        "no": next_no(), "time": hop_time,
                        "src": hop_from.get("ip") or hop_from.get("name") or target_ip,
                        "dst": hop_to.get("ip") or hop_to.get("name") or src_ip,
                        "protocol": "ICMP", "len": 74,
                        "info": f"Echo (ping) reply    id=0x0001, seq={seq}/256, ttl={max(1, 64 - hop_index)} hop {hop_index + 1}/{reply_hops}"
                    })

                output_lines.append(
                    f"64 bytes from {target_ip}: icmp_seq={seq} ttl=64 time={rtt_ms:.2f} ms"
                )

            avg_rtt = sum(rtt_samples) / len(rtt_samples)
            variance = sum((value - avg_rtt) ** 2 for value in rtt_samples) / len(rtt_samples)
            mdev = math.sqrt(variance)
            output_lines += [
                "",
                f"--- {target_ip} ping statistics ---",
                f"{count} packets transmitted, {count} received, 0% packet loss, time {count * 1000}ms",
                f"rtt min/avg/max/mdev = {min(rtt_samples):.3f}/{avg_rtt:.3f}/{max(rtt_samples):.3f}/{mdev:.3f} ms",
            ]
        else:
            # Target not on network — ARP timeouts
            for seq in range(1, count + 1):
                t = round(seq * 1.002, 3)
                packets.append({
                    "no": next_no(), "time": t,
                    "src": src_mac, "dst": "ff:ff:ff:ff:ff:ff",
                    "protocol": "ARP", "len": 42,
                    "info": f"Who has {target_ip}?  Tell {src_ip}"
                })
                output_lines.append(
                    f"From {src_ip} icmp_seq={seq} Destination Host Unreachable"
                )

            output_lines += [
                "",
                f"--- {target_ip} ping statistics ---",
                f"{count} packets transmitted, 0 received, 100% packet loss, time {count * 1000}ms",
            ]

    elif cmd == "traceroute" and len(parts) >= 2:
        target_token = parts[1]
        devices_by_id = {str(device.get("id")): device for device in devices}
        target_device = find_device_by_token(devices, target_token)

        if not target_device or not target_device.get("ip"):
            output_lines = [f"traceroute: unknown host {target_token}"]
            return jsonify({"output": output_lines, "packets": []})

        source = devices_by_id.get(source_device_id) if source_device_id else None
        if not source:
            source = next((device for device in devices if device.get("ip") and str(device.get("id")) != str(target_device.get("id"))), None)

        if not source:
            output_lines = ["traceroute: no suitable source host"]
            return jsonify({"output": output_lines, "packets": []})

        if not source.get("ip"):
            output_lines = [f"traceroute: source '{source.get('name')}' has no IP configured"]
            return jsonify({"output": output_lines, "packets": []})

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
                output_lines.append(f"route lookup: {target_ip} matched {selected_route.get('network')} via {selected_route.get('via')}")
            else:
                output_lines.append(f"route lookup: {target_ip} matched connected {selected_route.get('network')}")
        elif has_static_routes(source):
            output_lines.append(f"route lookup: no matching route for {target_ip}")
        else:
            output_lines.append("route lookup: topology path fallback (no static routes configured)")

        if not path:
            output_lines.append(f"traceroute: destination unreachable ({route_error or 'no route in topology'})")
            return jsonify({"output": output_lines, "packets": []})

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

    return jsonify({"output": output_lines, "packets": packets})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
