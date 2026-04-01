
from flask import Flask, request, jsonify
from flask_cors import CORS
import random
import math

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


@app.route("/api/run-command", methods=["POST"])
def run_command():
    data = request.json
    command = (data.get("command") or "").strip()
    devices = data.get("devices", [])

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

        ip_devices = [d for d in devices if d.get("ip")]
        source = ip_devices[0] if ip_devices else None
        target = next((d for d in ip_devices if d.get("ip") == target_ip), None)

        src_ip = source["ip"] if source else "192.168.1.1"
        src_mac = make_mac()
        dst_mac = make_mac()

        output_lines.append(f"PING {target_ip} ({target_ip}) 56(84) bytes of data.")

        if target:
            # ARP resolution
            packets.append({
                "no": next_no(), "time": 0.0,
                "src": src_mac, "dst": "ff:ff:ff:ff:ff:ff",
                "protocol": "ARP", "len": 42,
                "info": f"Who has {target_ip}?  Tell {src_ip}"
            })
            packets.append({
                "no": next_no(), "time": round(random.uniform(0.0005, 0.002), 4),
                "src": dst_mac, "dst": src_mac,
                "protocol": "ARP", "len": 42,
                "info": f"{target_ip} is at {dst_mac}"
            })

            rtt_samples = []
            for seq in range(1, count + 1):
                base = round(seq * 0.05 + random.uniform(0, 0.005), 4)
                rtt_ms = round(random.uniform(0.4, 2.5), 2)
                rtt_samples.append(rtt_ms)
                packets.append({
                    "no": next_no(), "time": base,
                    "src": src_ip, "dst": target_ip,
                    "protocol": "ICMP", "len": 74,
                    "info": f"Echo (ping) request  id=0x0001, seq={seq}/256, ttl=64"
                })
                packets.append({
                    "no": next_no(), "time": round(base + rtt_ms / 1000, 4),
                    "src": target_ip, "dst": src_ip,
                    "protocol": "ICMP", "len": 74,
                    "info": f"Echo (ping) reply    id=0x0001, seq={seq}/256, ttl=64 (request in {pkt_counter[0]-1})"
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
