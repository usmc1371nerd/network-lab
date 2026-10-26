"""Per-command link delivery for ping; results drive output and animation alike."""

import random


class LinkSimulation:
    def __init__(self, connections):
        self.connections = connections
        self.queues = {}
        self.clock = 0.0

    def transmit(self, packet, from_id, to_id):
        packet.update(fromDeviceId=str(from_id), toDeviceId=str(to_id), simulationApplied=True)
        conn = next((c for c in self.connections
                     if {str(c.get("from")), str(c.get("to"))} == {str(from_id), str(to_id)}), None)

        def drop(reason):
            packet.update(status="dropped", dropReason=reason,
                          info=f"DROP ({reason}) {packet['info']}")
            return False

        if not conn:
            return drop("no-link")
        forward = str(conn.get("from")) == str(from_id)
        direction = conn.get("direction") or "both"
        if direction != "both" and direction != ("forward" if forward else "reverse"):
            return drop("direction-block")
        conditions = conn.get("conditions") or {}
        if conditions.get("blocked"):
            return drop("blocked")

        def number(key, default, minimum=0, maximum=float("inf")):
            try:
                return max(minimum, min(maximum, float(conditions.get(key, default))))
            except (TypeError, ValueError):
                return default

        loss = number("lossPct", 0, maximum=100)
        if random.random() * 100 < loss:
            return drop(f"loss {loss:g}%")

        arrival = max(float(packet.get("time", 0)), self.clock)
        # Independent queues for the two directions of a full-duplex link.
        key = (str(from_id), str(to_id))
        queue = [departure for departure in self.queues.get(key, []) if departure > arrival]
        self.queues[key] = queue
        depth = len(queue)
        if conditions.get("redEnabled"):
            low = number("redMinTh", 80)
            high = max(low + 1, number("redMaxTh", 150))
            probability = number("redMaxDropPct", 30, maximum=100)
            if depth >= low:
                probability *= min(1, (depth - low) / (high - low))
                if random.random() * 100 < probability:
                    return drop(f"red {probability:.1f}%")
        limit = int(number("queueLimitPkts", 200, minimum=1))
        if depth >= limit:
            return drop(f"queue-full {limit}")
        service = 1 / number("bandwidthPps", 100, minimum=1)
        jitter = number("jitterMs", 0)
        latency = max(0, number("latencyMs", 0) + random.uniform(-jitter, jitter)) / 1000
        departure = max(arrival, queue[-1] if queue else arrival) + service
        queue.append(departure)
        self.clock = departure + latency
        packet.update(time=round(self.clock, 6), status="delivered")
        return True
