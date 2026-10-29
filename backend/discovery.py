"""Opt-in localhost-only Linux host discovery. No arbitrary command execution."""
import atexit
import ipaddress
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

from flask import Blueprint, jsonify, request

MAX_OUTPUT = 5 * 1024 * 1024
PRIVATE = [ipaddress.ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")]


class DiscoveryError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def ip_json(*arguments):
    executable = shutil.which("ip")
    if not executable:
        raise DiscoveryError("Install iproute2 to detect local network settings.", 503)
    try:
        result = subprocess.run([executable, "-j", "-4", *arguments], capture_output=True, text=True, timeout=3, check=True)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        raise DiscoveryError("Could not read Linux network settings. XML import is still available.", 503)


def network_snapshot():
    addresses = ip_json("-d", "address", "show")
    routes = ip_json("route", "show", "table", "main")
    rules = ip_json("rule", "show")
    restricted = any(rule.get("table") not in ("local", "main", "default", 253, 254, 255) or rule.get("fwmark") for rule in rules)
    networks = []
    for interface in addresses:
        name = interface.get("ifname", "")
        kind = interface.get("linkinfo", {}).get("info_kind", "")
        if name.startswith(("lo", "docker", "br-", "veth", "tun", "tap", "wg", "tailscale", "virbr", "vboxnet", "vmnet")) or kind in {"bridge", "veth", "tun", "wireguard", "vxlan", "dummy"}:
            continue
        if interface.get("operstate") not in ("UP", "UNKNOWN") or "UP" not in interface.get("flags", []):
            continue
        gateway = next((route.get("gateway", "") for route in routes if route.get("dst") == "default" and route.get("dev") == name), "")
        for address in interface.get("addr_info", []):
            try:
                local = ipaddress.ip_interface(f"{address['local']}/{address['prefixlen']}")
            except (KeyError, ValueError):
                continue
            if local.version != 4 or not any(local.network.subnet_of(parent) for parent in PRIVATE):
                continue
            suggested = ipaddress.ip_network(f"{local.ip}/{max(local.network.prefixlen, 24)}", strict=False)
            networks.append({"id": f"{name}:{local}", "interface": name, "address": str(local.ip),
                             "connectedCidr": str(local.network), "suggestedCidr": str(suggested), "gateway": gateway})
    networks.sort(key=lambda network: (not bool(network["gateway"]), network["interface"]))
    return {"networks": networks, "routes": routes, "restrictedRouting": restricted}


def choose_target(snapshot, interface_id, cidr):
    network = next((item for item in snapshot["networks"] if item["id"] == interface_id), None)
    if not network:
        raise DiscoveryError("This interface is no longer available. Refresh network settings.")
    try:
        target = ipaddress.ip_network(cidr, strict=True)
    except (ValueError, TypeError):
        raise DiscoveryError("Enter a network CIDR such as 192.168.1.0/24, using the network address.")
    if target.version != 4 or target.num_addresses > 256 or not target.subnet_of(ipaddress.ip_network(network["connectedCidr"])):
        raise DiscoveryError("Choose at most 256 IPv4 addresses within the selected directly connected network.")
    if not any(target.subnet_of(parent) for parent in PRIVATE):
        raise DiscoveryError("Local discovery supports private LAN ranges only.")
    connected = ipaddress.ip_network(network["connectedCidr"])
    for route in snapshot.get("routes", []):
        try:
            destination = ipaddress.ip_network(route.get("dst", ""))
        except ValueError:
            continue
        if destination.version == 4 and destination.prefixlen > connected.prefixlen and destination.overlaps(target) and (route.get("dev") != network["interface"] or route.get("gateway")):
            raise DiscoveryError("A more specific route redirects part of this range. Use XML import or choose a smaller unaffected range.")
    return {**network, "cidr": str(target), "addressCount": target.num_addresses,
            "requiresRouteCheck": bool(snapshot.get("restrictedRouting"))}


def verify_local_routes(network, cancelled=lambda: False):
    """Ask the kernel where each target goes. Route lookups send no probes."""
    started = time.monotonic()
    for address in ipaddress.ip_network(network["cidr"]).hosts():
        if cancelled():
            raise DiscoveryError("Discovery cancelled.")
        if time.monotonic() - started > 8:
            raise DiscoveryError("Route verification took too long. Choose a smaller discovery range.")
        try:
            routes = ip_json("route", "get", str(address))
        except DiscoveryError:
            raise DiscoveryError(f"Could not verify the route to {address}. No discovery probes were started.")
        if not routes:
            raise DiscoveryError(f"No route to {address}. No discovery probes were started.")
        for route in routes:
            if route.get("type") == "local" and route.get("dev") == "lo":
                continue
            if route.get("dev") != network["interface"] or route.get("gateway") or "linkdown" in route.get("flags", []) or route.get("type", "unicast") != "unicast":
                raise DiscoveryError(f"The route to {address} leaves the selected interface or uses a gateway. Choose an unaffected range or import XML.")


def neighbor_snapshot(network):
    try:
        records = ip_json("neigh", "show", "dev", network["interface"])
    except DiscoveryError:
        return []
    result = []
    target = ipaddress.ip_network(network["cidr"])
    for record in records:
        try:
            if ipaddress.ip_address(record.get("dst", "")) not in target:
                continue
        except ValueError:
            continue
        address = record.get("lladdr", "")
        if len(address.split(":")) == 6:
            result.append({"ip": record["dst"], "mac": address.lower()})
    return result[:256]


class DiscoveryManager:
    def __init__(self, network_reader=network_snapshot, neighbor_reader=neighbor_snapshot, spawn=None, timeout=120, route_checker=verify_local_routes):
        self.network_reader = network_reader
        self.neighbor_reader = neighbor_reader
        self.spawn = spawn
        self.route_checker = route_checker
        self.timeout = timeout
        self.token = secrets.token_urlsafe(32)
        self.jobs = {}
        self.lock = threading.Lock()

    def capabilities(self):
        supported = sys.platform.startswith("linux")
        snapshot = self.network_reader() if supported else {"networks": [], "restrictedRouting": False}
        nmap = bool(shutil.which("nmap"))
        reason = ""
        if not supported:
            reason = "Live discovery currently supports Linux. You can import Nmap XML on any platform."
        elif not nmap:
            reason = "Install Nmap locally to run host discovery. XML import still works."
        elif not snapshot["networks"]:
            reason = "No active private LAN interface was found. Virtual and VPN interfaces are excluded."
        with self.lock:
            active = next((job["id"] for job in self.jobs.values() if job["status"] in ("queued", "running")), None)
            recent = next((job["id"] for job in reversed(list(self.jobs.values())) if job["status"] == "completed" and time.monotonic() - job.get("ended", 0) < 900), None)
        return {"enabled": True, "supported": supported, "nmapAvailable": nmap, "networks": snapshot["networks"],
                "canStart": not reason, "reason": reason, "routingNotice": "Custom routing detected. The selected range will be verified before discovery starts." if snapshot.get("restrictedRouting") else "",
                "token": self.token, "activeJob": active, "recentJob": recent, "maxAddresses": 256, "timeoutSeconds": self.timeout}

    def start(self, interface_id, cidr):
        if not sys.platform.startswith("linux"):
            raise DiscoveryError("Live discovery currently supports Linux.", 503)
        executable = shutil.which("nmap")
        if not executable:
            raise DiscoveryError("Install Nmap locally before starting discovery.", 503)
        network = choose_target(self.network_reader(), interface_id, cidr)
        with self.lock:
            if any(job["status"] in ("queued", "running") for job in self.jobs.values()):
                raise DiscoveryError("A discovery job is already running. Wait or cancel it first.", 409)
            # Keep only the latest completed jobs; results are memory-only.
            terminal = [key for key, job in self.jobs.items() if job["status"] not in ("queued", "running")]
            for key in terminal[:-9]:
                del self.jobs[key]
            identifier = secrets.token_urlsafe(18)
            self.jobs[identifier] = {"id": identifier, "status": "queued", "network": network, "started": time.monotonic(),
                                     "startedAt": datetime.now(timezone.utc).isoformat(), "phase": "preparing", "cancel": False, "process": None, "error": "", "xml": "", "neighbors": []}
        threading.Thread(target=self._run, args=(identifier, executable), daemon=True).start()
        return self.get(identifier)

    def get(self, identifier):
        with self.lock:
            job = self.jobs.get(identifier)
            if not job:
                raise DiscoveryError("Discovery job not found. Results expire when the local app restarts.", 404)
            if job.get("ended") and time.monotonic() - job["ended"] > 900:
                raise DiscoveryError("Discovery results expired after 15 minutes. Start another discovery.", 404)
            elapsed = (job.get("ended") or time.monotonic()) - job["started"]
            result = {key: job[key] for key in ("id", "status", "network", "error", "startedAt", "phase")}
            result["elapsedSeconds"] = int(elapsed)
            result["timeoutSeconds"] = self.timeout
            if job["status"] == "completed":
                result.update(xml=job["xml"], neighbors=job["neighbors"])
            return result

    def cancel(self, identifier):
        with self.lock:
            job = self.jobs.get(identifier)
            if not job:
                raise DiscoveryError("Discovery job not found.", 404)
            if job["status"] in ("queued", "running"):
                job["cancel"] = True
                process = job["process"]
                if process:
                    try:
                        process.terminate()
                    except OSError:
                        pass
        return self.get(identifier)

    def shutdown(self):
        for identifier in list(self.jobs):
            try:
                self.cancel(identifier)
            except DiscoveryError:
                pass

    def _run(self, identifier, executable):
        process = None
        try:
            with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
                with self.lock:
                    job = self.jobs[identifier]
                    if job["network"].get("requiresRouteCheck"):
                        job["phase"] = "verifying-routes"
                if job["network"].get("requiresRouteCheck"):
                    self.route_checker(job["network"], lambda: job["cancel"])
                with self.lock:
                    job = self.jobs[identifier]
                    if job["cancel"]:
                        job.update(status="cancelled", ended=time.monotonic())
                        return
                    command = [executable, "--unprivileged", "-sn", "-n", "-T3", "--max-retries", "1",
                               "--host-timeout", "5s", "--max-rate", "32", "-oX", "-", job["network"]["cidr"]]
                    process = (self.spawn or subprocess.Popen)(command, stdout=output, stderr=errors, close_fds=True)
                    job.update(status="running", process=process, phase="discovering")
                while process.poll() is None:
                    if job["cancel"]:
                        raise DiscoveryError("Discovery cancelled.")
                    if time.monotonic() - job["started"] > self.timeout:
                        raise DiscoveryError("Discovery timed out. Try a smaller range.")
                    if os.fstat(output.fileno()).st_size > MAX_OUTPUT or os.fstat(errors.fileno()).st_size > 65536:
                        raise DiscoveryError("Discovery output exceeded its size limit.")
                    time.sleep(0.1)
                if job["cancel"]:
                    raise DiscoveryError("Discovery cancelled.")
                if process.returncode != 0:
                    raise DiscoveryError("Nmap could not complete discovery. Check that Nmap runs as your normal local user.")
                output.seek(0)
                raw = output.read(MAX_OUTPUT + 1)
                if len(raw) > MAX_OUTPUT:
                    raise DiscoveryError("Discovery output exceeded 5 MB.")
                xml = raw.decode("utf-8", errors="strict")
                if "<nmaprun" not in xml or "</nmaprun>" not in xml:
                    raise DiscoveryError("Nmap did not return a complete XML result.")
                neighbors = self.neighbor_reader(job["network"])
                with self.lock:
                    job.update(status="cancelled" if job["cancel"] else "completed", xml=xml, neighbors=neighbors, ended=time.monotonic())
        except (DiscoveryError, OSError, UnicodeError) as failure:
            with self.lock:
                job = self.jobs[identifier]
                job.update(status="cancelled" if job["cancel"] else "failed", error=str(failure), ended=time.monotonic())
        finally:
            if process and process.poll() is None:
                try:
                    process.terminate()
                    process.wait(timeout=2)
                except (OSError, subprocess.TimeoutExpired):
                    process.kill()
                    process.wait(timeout=2)


def discovery_blueprint(manager=None):
    service = manager or DiscoveryManager()
    atexit.register(service.shutdown)
    blueprint = Blueprint("local_discovery", __name__, url_prefix="/api/discovery")

    @blueprint.before_request
    def guard():
        enabled = os.environ.get("NETWORK_LAB_DISCOVERY") == "1"
        if not enabled:
            if request.endpoint == "local_discovery.capabilities":
                return jsonify(enabled=False, canStart=False, reason="Live discovery is available when you run dev-start.sh locally. XML import works here.")
            return jsonify(error="Local discovery is disabled."), 403
        try:
            peer = ipaddress.ip_address(request.remote_addr or "")
            host = urlsplit(f"http://{request.host}").hostname
            if not peer.is_loopback or host not in ("localhost", "127.0.0.1", "::1"):
                raise ValueError()
            # A public reverse proxy must not turn remote clients into local peers.
            if request.headers.get("Forwarded"):
                raise ValueError()
            forwarded = request.headers.get("X-Forwarded-For", "")
            if forwarded and any(not ipaddress.ip_address(value.strip()).is_loopback for value in forwarded.split(",")):
                raise ValueError()
            real_ip = request.headers.get("X-Real-IP")
            if real_ip and not ipaddress.ip_address(real_ip).is_loopback:
                raise ValueError()
            forwarded_host = request.headers.get("X-Forwarded-Host")
            if forwarded_host and urlsplit(f"http://{forwarded_host}").hostname not in ("localhost", "127.0.0.1", "::1"):
                raise ValueError()
            origin = request.headers.get("Origin")
            if origin:
                parsed = urlsplit(origin)
                allowed = {3000, 5000, urlsplit(f"http://{request.host}").port or (443 if request.scheme == "https" else 80)}
                if parsed.scheme not in ("http", "https") or parsed.hostname not in ("localhost", "127.0.0.1", "::1") or (parsed.port or (443 if parsed.scheme == "https" else 80)) not in allowed:
                    raise ValueError()
            if request.headers.get("Sec-Fetch-Site") == "cross-site":
                raise ValueError()
        except ValueError:
            return jsonify(error="Discovery is restricted to the local app on localhost."), 403
        if request.endpoint != "local_discovery.capabilities" and not secrets.compare_digest(request.headers.get("Authorization", "").encode("utf-8"), f"Bearer {service.token}".encode("utf-8")):
            return jsonify(error="Refresh local discovery to renew the session."), 403

    @blueprint.after_request
    def no_cache(response):
        response.headers["Cache-Control"] = "no-store"
        return response

    @blueprint.errorhandler(DiscoveryError)
    def handle_error(error):
        return jsonify(error=str(error)), error.status

    @blueprint.get("/capabilities")
    def capabilities():
        return jsonify(service.capabilities())

    @blueprint.post("/jobs")
    def start():
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            raise DiscoveryError("Choose an interface and CIDR range.")
        return jsonify(service.start(data.get("interfaceId"), data.get("cidr"))), 202

    @blueprint.get("/jobs/<identifier>")
    def status(identifier):
        return jsonify(service.get(identifier))

    @blueprint.delete("/jobs/<identifier>")
    def cancel(identifier):
        return jsonify(service.cancel(identifier))

    return blueprint
