"""Small IPv4 teaching firewall: ingress rules and per-command ICMP state."""
import ipaddress


def is_active(device):
    return device.get("type") == "firewall" and device.get("firewallEnabled") is True


def is_configured(device):
    return device.get("type") == "firewall" and (device.get("firewallVersion") == 1 or bool(device.get("interfaces")))


def interfaces(device):
    return [item for item in device.get("interfaces", []) if isinstance(item, dict) and item.get("enabled", True)]


def addresses(device):
    values = [] if is_configured(device) else [device.get("ip")]
    if device.get("type") == "firewall":
        values.extend(item.get("address") for item in interfaces(device))
    result = []
    for value in values:
        try:
            result.append(str(ipaddress.ip_interface(value).ip))
        except (ValueError, TypeError):
            pass
    return result


def interface_for_neighbor(device, neighbor):
    return next((item for item in interfaces(device) if str(item.get("neighborId")) == str(neighbor)), None)


def matches(token, address, interface):
    if token == "any":
        return True
    if token == "interface-net":
        token = interface.get("address")
    try:
        return ipaddress.ip_address(address) in ipaddress.ip_network(token, strict=False)
    except (TypeError, ValueError):
        return False


class FirewallSimulation:
    def __init__(self):
        self.logs = []
        self.states = set()

    def evaluate(self, device, ingress_neighbor, egress_neighbor, src, dst, seq, reply=False):
        if not is_active(device):
            return True
        ingress = interface_for_neighbor(device, ingress_neighbor)
        egress = interface_for_neighbor(device, egress_neighbor) if egress_neighbor is not None else True
        state_key = (str(device["id"]), dst if reply else src, src if reply else dst, seq)
        action, reason, rule_id = "block", "Default deny: no matching ingress rule", None
        if not ingress or not egress:
            reason = "Unassigned or disabled interface"
        elif reply and state_key in self.states:
            action, reason = "pass", "Established ICMP reply (state)"
        else:
            for rule in device.get("rules", []):
                if not isinstance(rule, dict) or not rule.get("enabled", True):
                    continue
                if rule.get("interfaceId") != ingress.get("id") or rule.get("protocol") not in ("any", "ICMP"):
                    continue
                if not matches(rule.get("source", "any"), src, ingress) or not matches(rule.get("destination", "any"), dst, ingress):
                    continue
                action = "pass" if rule.get("action") == "pass" else "block"
                reason = rule.get("description") or "Matched interface rule"
                rule_id = rule.get("id")
                break
        if action == "pass" and not reply:
            self.states.add(state_key)
        self.logs.append({
            "firewallId": str(device["id"]), "firewallName": device.get("name"),
            "interface": ingress.get("name") if ingress else "unassigned",
            "action": action, "reason": reason, "ruleId": rule_id,
            "src": src, "dst": dst, "protocol": "ICMP", "sequence": seq,
            "state": reply and action == "pass" and state_key in self.states,
        })
        return action == "pass"
