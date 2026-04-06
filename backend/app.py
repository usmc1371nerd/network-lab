
from flask import Flask, request, jsonify
from flask_cors import CORS
import random
import math
from collections import deque

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


def find_path(device_ids, connections, start_id, target_id):
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
        target_ip = parts[1]
        count = parse_ping_count(parts)
        devices_by_id = {str(device.get("id")): device for device in devices}

        ip_devices = [d for d in devices if d.get("ip")]
        source = None
        if source_device_id:
            source = next((d for d in ip_devices if str(d.get("id")) == source_device_id), None)
        target = next((d for d in ip_devices if d.get("ip") == target_ip), None)

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
            path = find_path(
                device_ids=[str(device.get("id")) for device in devices if device.get("id") is not None],
                connections=connections,
                start_id=str(source.get("id")) if source else "",
                target_id=str(target.get("id")),
            )

            if not path:
                output_lines += [
                    f"From {src_ip} Destination Host Unreachable (no route in topology)",
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

    elif cmd == "help":
        output_lines = [
            "Available commands:",
            "  ping <ip> [-c N]  - send ICMP echo requests",
            "  help              - show available commands",
            "  clear             - clear terminal output",
        ]
    else:
        output_lines = [f"bash: {cmd}: command not found"]

    return jsonify({"output": output_lines, "packets": packets})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
