
import React, { useState, useCallback, useEffect, useRef } from "react";
import NetworkCanvas from "./components/NetworkCanvas";
import Terminal from "./components/Terminal";
import PacketLog from "./components/PacketLog";
import FirewallDashboard from "./components/FirewallDashboard";
import DeviceProfile from "./components/DeviceProfile";
import NmapImport from "./components/NmapImport";
import InventoryWorkspace from "./components/InventoryWorkspace";
import LocalDiscovery from "./components/LocalDiscovery";
import { applyNmapReview, practiceCopies } from "./nmapImport.mjs";
import { buildProfileUpdate, BLUETOOTH_TYPES } from "./deviceProfile.mjs";
import { DEFAULT_VIEW, MAX_LAB_FILE_BYTES, labConfiguration, configurationSignature, serializeLab, parseLab } from "./labFile.mjs";

let _id = 1;
const uid = () => String(_id++);
const NON_IP_CAPABLE_TYPES = new Set([
  "usb-storage",
  "usb-keyboard",
  "usb-mouse",
  "usb-webcam",
  "usb-audio",
  "usb-printer",
  "beacon",
  "sensor",
  "iot-tag",
]);

const makeBtMac = () =>
  Array.from({ length: 6 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0"))
    .join(":");

const makeStableMac = (seed) => {
  const text = String(seed ?? "0");
  let hash = 2166136261;
  for (const ch of text) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const bytes = [0x02, 0x00, 0x00, (hash >>> 16) & 0xff, (hash >>> 8) & 0xff, hash & 0xff];
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(":");
};

const DEFAULT_LINK_CONDITIONS = {
  lossPct: 0,
  latencyMs: 0,
  jitterMs: 0,
  queueLimitPkts: 200,
  bandwidthPps: 100,
  redEnabled: false,
  redMinTh: 80,
  redMaxTh: 150,
  redMaxDropPct: 30,
  blocked: false,
};

export default function App() {
  const [devices, setDevices] = useState([]);
  const [connections, setConnections] = useState([]);
  const [capturedPackets, setCapturedPackets] = useState([]);
  const [displayedPackets, setDisplayedPackets] = useState([]);
  const [trafficStats, setTrafficStats] = useState({});
  const [ipTrafficStats, setIpTrafficStats] = useState({});
  const [linkTrafficStats, setLinkTrafficStats] = useState({});
  const [packetFlights, setPacketFlights] = useState([]);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const linkRuntimeRef = useRef({});
  const flightTimeoutsRef = useRef([]);
  const [canvasView, setCanvasView] = useState(DEFAULT_VIEW);
  const [labSession, setLabSession] = useState(0);
  const [exportedSignature, setExportedSignature] = useState(() => configurationSignature(labConfiguration([], [], DEFAULT_VIEW)));
  const [fileMessage, setFileMessage] = useState(null);
  const [importing, setImporting] = useState(false);
  const [activeFirewallId, setActiveFirewallId] = useState(null);
  const [firewallLogs, setFirewallLogs] = useState([]);
  const [firewallPending, setFirewallPending] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState(null);
  const [profilePending, setProfilePending] = useState(false);
  const [inventory, setInventory] = useState([]);
  const [workspace, setWorkspace] = useState("lab");
  const [nmapImportOpen, setNmapImportOpen] = useState(false);
  const [selectedProfileScope, setSelectedProfileScope] = useState("lab");
  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [discoveryPending, setDiscoveryPending] = useState(false);
  const [localDiscoveryResult, setLocalDiscoveryResult] = useState(null);
  const importInputRef = useRef(null);
  const configuration = labConfiguration(devices, connections, canvasView, inventory);
  const signature = configurationSignature(configuration);
  const hasUnexportedChanges = signature !== exportedSignature || firewallPending || profilePending || discoveryPending || Boolean(nmapImportOpen && localDiscoveryResult);
  const currentLabRef = useRef(null);
  currentLabRef.current = { configuration, signature, hasUnexportedChanges };

  useEffect(() => {
    if (!hasUnexportedChanges) return;
    const warnBeforeLeaving = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [hasUnexportedChanges]);

  const exportLab = () => {
    try {
      const text = serializeLab(devices, connections, canvasView, inventory);
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `network-lab-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportedSignature(signature);
      setFileMessage({ kind: "success", text: "Backup download started. Keep the JSON file to restore your lab later." });
    } catch (error) {
      setFileMessage({ kind: "error", text: `Export failed: ${error.message}` });
    }
  };

  const importLab = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      if (file.size > MAX_LAB_FILE_BYTES) throw new Error("Lab files must be 5 MB or smaller.");
      const restored = parseLab(await file.text());
      const current = currentLabRef.current;
      if ((current.configuration.devices.length || current.configuration.connections.length || current.configuration.inventory.length || current.hasUnexportedChanges)
          && !window.confirm("Replace the current lab and inventory with this backup? Export first if you want to keep them. Running traffic and terminal sessions will be cleared.")) {
        return;
      }
      flightTimeoutsRef.current.forEach(clearTimeout);
      flightTimeoutsRef.current = [];
      linkRuntimeRef.current = {};
      setDevices(restored.devices);
      setInventory(restored.inventory);
      setWorkspace(restored.devices.length ? "lab" : restored.inventory.length ? "inventory" : "lab");
      setNmapImportOpen(false);
      setDiscoveryOpen(false); setDiscoveryPending(false); setLocalDiscoveryResult(null);
      setConnections(restored.connections);
      setCanvasView(restored.view);
      setCapturedPackets([]);
      setDisplayedPackets([]);
      setTrafficStats({});
      setIpTrafficStats({});
      setLinkTrafficStats({});
      setPacketFlights([]);
      setFirewallLogs([]);
      setActiveFirewallId(null);
      setFirewallPending(false);
      setSelectedProfileId(null);
      setProfilePending(false);
      setLabSession((previous) => previous + 1);
      setExportedSignature(configurationSignature(restored));
      setFileMessage({ kind: "success", text: `Imported ${file.name}. Configuration restored; simulation and terminal sessions reset.` });
    } catch (error) {
      setFileMessage({ kind: "error", text: `Import failed: ${error.message} Your current lab has not been changed.` });
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => {
    return () => {
      flightTimeoutsRef.current.forEach((timeoutId) => clearTimeout(timeoutId));
      flightTimeoutsRef.current = [];
    };
  }, []);

  useEffect(() => {
    setDevices((prev) => {
      let changed = false;
      const next = prev.map((device) => {
        if (!device?.name) return device;
        if (!device.type?.startsWith("usb-")) return device;
        if (!device.name.startsWith("USB-") || device.profile?.overrides?.name) return device;
        changed = true;
        return { ...device, name: device.name.replace(/^USB-/, "") };
      });
      return changed ? next : prev;
    });
  }, [devices.length]);

  useEffect(() => {
    setDevices((prev) => {
      let changed = false;
      const next = prev.map((device) => {
        if (!device) return device;
        if (!NON_IP_CAPABLE_TYPES.has(device.type)) return device;
        if (!device.ip) return device;
        changed = true;
        return { ...device, ip: "" };
      });
      return changed ? next : prev;
    });
  }, [devices]);

  useEffect(() => {
    setDevices((prev) => {
      let changed = false;
      const next = prev.map((device) => {
        if (!device) return device;
        const patch = {};
        if (!device.mac && !NON_IP_CAPABLE_TYPES.has(device.type)) {
          patch.mac = makeStableMac(device.id || device.name || device.type);
        }
        if (!NON_IP_CAPABLE_TYPES.has(device.type) && (typeof device.arp_table !== "object" || device.arp_table === null)) {
          patch.arp_table = {};
        }
        if (device.type === "switch" && (typeof device.mac_table !== "object" || device.mac_table === null)) {
          patch.mac_table = {};
        }
        if (Object.keys(patch).length === 0) return device;
        changed = true;
        return { ...device, ...patch };
      });
      return changed ? next : prev;
    });
  }, [devices]);

  useEffect(() => {
    const activeKeys = new Set(connections.map((conn) => `${conn.from}->${conn.to}`));
    const nextRuntime = {};
    Object.entries(linkRuntimeRef.current).forEach(([key, runtime]) => {
      if (activeKeys.has(key)) {
        nextRuntime[key] = runtime;
      }
    });
    linkRuntimeRef.current = nextRuntime;
  }, [connections]);

  const addDevice = useCallback((type, x, y) => {
    const names = {
      pc: "PC",
      server: "Server",
      router: "Router",
      firewall: "Firewall",
      switch: "Switch",
      phone: "Phone",
      laptop: "Laptop",
      beacon: "BLE-Beacon",
      sensor: "BLE-Sensor",
      gateway: "BT-Gateway",
      "iot-bulb": "IoT-Bulb",
      "iot-lock": "IoT-Lock",
      "iot-tag": "IoT-Tag",
      "iot-camera": "IoT-Camera",
      "iot-thermostat": "IoT-Thermostat",
      "iot-plug": "IoT-Plug",
      "usb-storage": "Storage",
      "usb-keyboard": "Keyboard",
      "usb-mouse": "Mouse",
      "usb-webcam": "Webcam",
      "usb-audio": "Audio",
      "usb-printer": "Printer",
    };
    let id = uid();
    while (devices.some((device) => device.id === id)) id = uid();
    setDevices((prev) => [
      ...prev,
      {
        id,
        type,
        name: `${names[type] || type}-${id}`,
        profile: { notes: "", overrides: { name: false, type: true, ip: false } },
        discovery: { observations: [] },
        ip: "",
        routes: [],
        ...(type === "firewall" ? { interfaces: [], rules: [], nat: [] } : {}),
        mac: NON_IP_CAPABLE_TYPES.has(type) ? "" : makeStableMac(id),
        arp_table: NON_IP_CAPABLE_TYPES.has(type) ? undefined : {},
        mac_table: type === "switch" ? {} : undefined,
        btMac: BLUETOOTH_TYPES.has(type) ? makeBtMac() : "",
        x,
        y,
      },
    ]);
  }, [devices]);

  const updateDevice = useCallback((id, fields) => {
    setDevices((prev) =>
      prev.map((d) => {
        if (d.id !== id) return d;
        const overrides = { ...d.profile?.overrides };
        let manualChange = false;
        for (const key of ["name", "type", "ip"]) {
          if (fields[key] !== undefined && fields[key] !== d[key]) { overrides[key] = true; manualChange = true; }
        }
        return { ...d, ...fields, ...(manualChange ? { profile: { ...d.profile, ...fields.profile, overrides: { ...overrides, ...fields.profile?.overrides } } } : {}) };
      })
    );
  }, []);

  const saveDeviceProfile = (id, draft) => {
    const collection = selectedProfileScope === "inventory" ? inventory : devices;
    const original = collection.find(device => device.id === id);
    if (!original) return { errors: ["This device no longer exists."] };
    const result = buildProfileUpdate(original, draft, collection);
    if (result.errors.length) return result;
    if (selectedProfileScope === "inventory") {
      setInventory(previous => previous.map(asset => asset.id === id ? result.device : asset));
      setSelectedProfileId(null); setProfilePending(false);
      return result;
    }
    if (BLUETOOTH_TYPES.has(result.device.type) && !result.device.btMac) result.device.btMac = makeBtMac();
    setDevices(previous => previous.map(device => device.id === id ? result.device : device));
    if (original.type !== result.device.type || original.ip !== result.device.ip) {
      setPacketFlights(previous => previous.filter(flight => flight.fromId !== id && flight.toId !== id));
      for (const key of Object.keys(linkRuntimeRef.current)) {
        if (key.split("->").includes(String(id))) delete linkRuntimeRef.current[key];
      }
    }
    if (original.type === "firewall" && result.device.type !== "firewall") {
      setActiveFirewallId(previous => previous === id ? null : previous);
      setFirewallLogs(previous => previous.filter(event => event.firewallId !== id));
    }
    setSelectedProfileId(null);
    setProfilePending(false);
    return result;
  };

  const removeDevice = useCallback((id) => {
    setActiveFirewallId((previous) => previous === id ? null : previous);
    setFirewallLogs((previous) => previous.filter(event => event.firewallId !== id));
    setDevices((prev) => prev.filter((d) => d.id !== id).map((device) => {
      if (device.type === "firewall") {
        device = { ...device, interfaces: (device.interfaces || []).map(item => item.neighborId === id ? { ...item, neighborId: "", enabled: false } : item) };
        if (!device.interfaces.some(item => item.enabled)) device.firewallEnabled = false;
      }
      if (!device.mac_table) return device;
      return {
        ...device,
        mac_table: Object.fromEntries(Object.entries(device.mac_table).filter(
          ([, port]) => port !== `link-${device.id}-${id}`
        )),
      };
    }));
    Object.keys(linkRuntimeRef.current).forEach((key) => {
      const [fromId, toId] = key.split("->");
      if (fromId === String(id) || toId === String(id)) {
        delete linkRuntimeRef.current[key];
      }
    });
    setConnections((prev) =>
      prev.filter((c) => c.from !== id && c.to !== id)
    );
    setTrafficStats((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setIpTrafficStats((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setLinkTrafficStats((prev) => {
      const next = {};
      Object.entries(prev).forEach(([key, value]) => {
        const [fromId, toId] = key.split("->");
        if (fromId !== String(id) && toId !== String(id)) {
          next[key] = value;
        }
      });
      return next;
    });
    setPacketFlights((prev) =>
      prev.filter((flight) => flight.fromId !== id && flight.toId !== id)
    );
  }, []);

  const removeConnection = useCallback((from, to) => {
    setConnections((prev) => prev.filter((conn) =>
      !((conn.from === from && conn.to === to) || (conn.from === to && conn.to === from))
    ));
    const keys = [`${from}->${to}`, `${to}->${from}`];
    keys.forEach((key) => delete linkRuntimeRef.current[key]);
    setLinkTrafficStats((prev) => {
      const next = { ...prev };
      keys.forEach((key) => delete next[key]);
      return next;
    });
    setPacketFlights((prev) => prev.filter((flight) => !keys.includes(flight.linkKey)));
    setDevices((prev) => prev.map((device) => {
      const neighbor = device.id === from ? to : device.id === to ? from : null;
      if (neighbor !== null && device.type === "firewall") {
        device = { ...device, interfaces: (device.interfaces || []).map(item => item.neighborId === neighbor ? { ...item, neighborId: "", enabled: false } : item) };
        if (!device.interfaces.some(item => item.enabled)) device.firewallEnabled = false;
      }
      if (neighbor === null || !device.mac_table) return device;
      const mac_table = Object.fromEntries(Object.entries(device.mac_table).filter(
        ([, port]) => port !== `link-${device.id}-${neighbor}`
      ));
      return { ...device, mac_table };
    }));
  }, []);

  const addConnection = useCallback((from, to, direction = "both", transport = "cat") => {
    setConnections((prev) => {
      const existing = prev.find(
        (c) => (c.from === from && c.to === to) || (c.from === to && c.to === from)
      );
      if (!existing) {
        return [...prev, {
          from,
          to,
          direction,
          transport,
          conditions: { ...DEFAULT_LINK_CONDITIONS },
        }];
      }
      return prev.map((c) => {
        if ((c.from === from && c.to === to) || (c.from === to && c.to === from)) {
          return {
            ...c,
            direction,
            transport,
            conditions: { ...DEFAULT_LINK_CONDITIONS, ...(c.conditions || {}) },
          };
        }
        return c;
      });
    });
  }, []);

  const updateConnection = useCallback((from, to, fields) => {
    setConnections((prev) =>
      prev.map((conn) => {
        if ((conn.from === from && conn.to === to) || (conn.from === to && conn.to === from)) {
          const mergedConditions = {
            ...DEFAULT_LINK_CONDITIONS,
            ...(conn.conditions || {}),
            ...(fields.conditions || {}),
          };
          return { ...conn, ...fields, conditions: mergedConditions };
        }
        return conn;
      })
    );
  }, []);

  const appendCapturedPackets = useCallback((newPkts) => {
    setCapturedPackets((prev) => {
      const offset = prev.length;
      return [
        ...prev,
        ...newPkts.map((p, i) => ({ ...p, no: offset + i + 1 })),
      ];
    });
  }, []);

  const clearCapturedPackets = useCallback(() => {
    setCapturedPackets([]);
    setDisplayedPackets([]);
  }, []);

  const applyTrafficPackets = useCallback((newPkts) => {
    if (!Array.isArray(newPkts) || newPkts.length === 0) {
      return { deliveredPackets: [], droppedPackets: [] };
    }

    const findDeviceIdByAddress = (addr) => {
      if (!addr) return null;
      const normalized = String(addr).toLowerCase();
      const device = devices.find((d) =>
        d.ip === addr ||
        (d.btMac && d.btMac.toLowerCase() === normalized) ||
        d.name.toLowerCase() === normalized
      );
      return device?.id || null;
    };

    const deliveredPackets = [];
    const droppedPackets = [];
    const trafficIncrements = [];
    const linkIncrements = [];
    const flights = [];

    const toNumber = (value, fallback = 0) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    newPkts.forEach((packet) => {
      // Network addresses identify endpoints; hop IDs identify the physical cable.
      const srcId = devices.find((d) => String(d.id) === String(packet.fromDeviceId))?.id
        ?? findDeviceIdByAddress(packet.src);
      const dstId = devices.find((d) => String(d.id) === String(packet.toDeviceId))?.id
        ?? findDeviceIdByAddress(packet.dst);

      if (["ROUTE", "L2", "FIREWALL"].includes(String(packet.protocol || "").toUpperCase())) {
        deliveredPackets.push(packet);
        return;
      }

      if (!srcId || !dstId) {
        deliveredPackets.push(packet);
        return;
      }

      const conn = connections.find(
        (c) =>
          (c.from === srcId && c.to === dstId) ||
          (c.from === dstId && c.to === srcId)
      );
      const protocol = String(packet.protocol || "").toUpperCase();
      const isIpTraffic = ["ICMP", "ARP", "TCP", "UDP", "IP", "IPV6"].includes(protocol);

      const dropPacket = (reason, linkKey, blocked = false, queue = false, red = false) => {
        droppedPackets.push({
          ...packet,
          status: "dropped",
          info: `DROP (${reason})${packet.info ? ` ${packet.info}` : ""}`,
        });
        if (linkKey) {
          linkIncrements.push({ type: "drop", key: linkKey, blocked, queue, red });
        }
      };

      if (!conn) {
        dropPacket("no-link", null, false);
        return;
      }
      const linkKey = `${conn.from}->${conn.to}`;
      if (packet.simulationApplied && packet.status === "dropped") {
        droppedPackets.push(packet);
        const reason = packet.dropReason || "";
        linkIncrements.push({
          type: "drop", key: linkKey,
          blocked: ["blocked", "direction-block"].includes(reason),
          queue: reason.startsWith("queue-full"), red: reason.startsWith("red"),
        });
        return;
      }
      let delayedPacket = packet;
      let effectiveLatencyMs = 0;
      let serviceIntervalMs = 0;

      // Backend ping delivery already determines replies, statistics and caches.
      if (!packet.simulationApplied) {
        const direction = conn.direction || "both";
        const isForward = conn.from === srcId && conn.to === dstId;
        const isReverse = conn.to === srcId && conn.from === dstId;
        const allowed =
          direction === "both" ||
          (direction === "forward" && isForward) ||
          (direction === "reverse" && isReverse);

        if (!allowed) {
          dropPacket("direction-block", linkKey, true);
          return;
        }

        const conditions = { ...DEFAULT_LINK_CONDITIONS, ...(conn.conditions || {}) };
        if (conditions.blocked) {
          dropPacket("blocked", linkKey, true);
          return;
        }

        const lossPct = Math.max(0, Math.min(100, toNumber(conditions.lossPct, 0)));
        if (Math.random() * 100 < lossPct) {
          dropPacket(`loss ${lossPct}%`, linkKey, false);
          return;
        }

        const latencyMs = Math.max(0, toNumber(conditions.latencyMs, 0));
        const jitterMs = Math.max(0, toNumber(conditions.jitterMs, 0));
        const queueLimitPkts = Math.max(1, Math.trunc(toNumber(conditions.queueLimitPkts, 200)));
        const bandwidthPps = Math.max(1, toNumber(conditions.bandwidthPps, 100));
        serviceIntervalMs = 1000 / bandwidthPps;
        const redEnabled = Boolean(conditions.redEnabled);
        const redMinThRaw = Math.max(0, Math.trunc(toNumber(conditions.redMinTh, 80)));
        const redMaxThRaw = Math.max(0, Math.trunc(toNumber(conditions.redMaxTh, 150)));
        const redMaxDropPct = Math.max(0, Math.min(100, toNumber(conditions.redMaxDropPct, 30)));
        const baseTime = toNumber(packet.time, 0);
        const arrivalMs = Math.max(0, Math.round(baseTime * 1000));

        const runtime = linkRuntimeRef.current[linkKey] || { queue: [] };
        runtime.queue = runtime.queue.filter((departureMs) => departureMs > arrivalMs);
        const queueDepth = runtime.queue.length;

        if (redEnabled) {
          const redMaxTh = Math.max(redMinThRaw + 1, redMaxThRaw);
          if (queueDepth >= redMinThRaw) {
            let redDropProb = redMaxDropPct;
            if (queueDepth < redMaxTh) {
              const ratio = (queueDepth - redMinThRaw) / (redMaxTh - redMinThRaw);
              redDropProb = ratio * redMaxDropPct;
            }
            if (Math.random() * 100 < redDropProb) {
              linkRuntimeRef.current[linkKey] = runtime;
              dropPacket(`red ${redDropProb.toFixed(1)}%`, linkKey, false, false, true);
              return;
            }
          }
        }

        if (runtime.queue.length >= queueLimitPkts) {
          linkRuntimeRef.current[linkKey] = runtime;
          dropPacket(`queue-full ${queueLimitPkts}`, linkKey, false, true);
          return;
        }

        const jitterOffset = jitterMs > 0 ? (Math.random() * 2 - 1) * jitterMs : 0;
        effectiveLatencyMs = Math.max(0, latencyMs + jitterOffset);
        const headDeparture = runtime.queue.length > 0 ? runtime.queue[runtime.queue.length - 1] : arrivalMs;
        const departureMs = Math.max(arrivalMs, headDeparture) + serviceIntervalMs + effectiveLatencyMs;
        runtime.queue.push(departureMs);
        linkRuntimeRef.current[linkKey] = runtime;

        delayedPacket = {
          ...packet,
          time: Number((departureMs / 1000).toFixed(4)),
        };
      }

      deliveredPackets.push(delayedPacket);
      trafficIncrements.push({ srcId, dstId, isIpTraffic });
      linkIncrements.push({
        type: "flow",
        key: linkKey,
        direction: conn.from === srcId && conn.to === dstId ? "forward" : "reverse",
      });
      flights.push({
        id: `flight-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        linkKey,
        direction: conn.from === srcId && conn.to === dstId ? "forward" : "reverse",
        protocol: String(packet.protocol || "").toUpperCase(),
        fromId: srcId,
        toId: dstId,
        createdAt: Date.now(),
        durationMs: Math.max(1400, Math.min(4200, Math.round((effectiveLatencyMs + serviceIntervalMs + 700) * 2.2))),
      });
    });

    if (flights.length > 0) {
      setPacketFlights((prev) => [...prev, ...flights]);
      flights.forEach((flight) => {
        const timeoutId = setTimeout(() => {
          setPacketFlights((prev) => prev.filter((item) => item.id !== flight.id));
        }, flight.durationMs + 120);
        flightTimeoutsRef.current.push(timeoutId);
      });
    }

    setTrafficStats((prev) => {
      const next = { ...prev };

      trafficIncrements.forEach(({ srcId, dstId }) => {
        const prevSrc = next[srcId] || { inbound: 0, outbound: 0 };
        next[srcId] = { ...prevSrc, outbound: prevSrc.outbound + 1 };
        const prevDst = next[dstId] || { inbound: 0, outbound: 0 };
        next[dstId] = { ...prevDst, inbound: prevDst.inbound + 1 };
      });

      return next;
    });

    setIpTrafficStats((prev) => {
      const next = { ...prev };

      trafficIncrements.forEach(({ srcId, dstId, isIpTraffic }) => {
        if (!isIpTraffic) return;
        const prevSrc = next[srcId] || { inbound: 0, outbound: 0 };
        next[srcId] = { ...prevSrc, outbound: prevSrc.outbound + 1 };
        const prevDst = next[dstId] || { inbound: 0, outbound: 0 };
        next[dstId] = { ...prevDst, inbound: prevDst.inbound + 1 };
      });

      return next;
    });

    setLinkTrafficStats((prev) => {
      const next = { ...prev };

      linkIncrements.forEach((item) => {
        const prevLink = next[item.key] || {
          forward: 0,
          reverse: 0,
          dropped: 0,
          blocked: 0,
          queueDrops: 0,
          redDrops: 0,
        };
        if (item.type === "flow") {
          if (item.direction === "forward") {
            next[item.key] = { ...prevLink, forward: prevLink.forward + 1 };
          } else {
            next[item.key] = { ...prevLink, reverse: prevLink.reverse + 1 };
          }
        } else {
          next[item.key] = {
            ...prevLink,
            dropped: prevLink.dropped + 1,
            blocked: prevLink.blocked + (item.blocked ? 1 : 0),
            queueDrops: prevLink.queueDrops + (item.queue ? 1 : 0),
            redDrops: prevLink.redDrops + (item.red ? 1 : 0),
          };
        }
      });

      return next;
    });

    return { deliveredPackets, droppedPackets };
  }, [devices, connections]);

  const showCapturedPackets = useCallback(() => {
    setDisplayedPackets(capturedPackets);
  }, [capturedPackets]);

  const appendFirewallLogs = useCallback((events) => {
    if (!Array.isArray(events) || !events.length) return;
    setFirewallLogs((previous) => [...previous, ...events.map(event => ({ ...event, recordedAt: Date.now() }))].slice(-500));
  }, []);
  const activeFirewall = workspace === "lab" && devices.find(device => device.id === activeFirewallId && device.type === "firewall");
  const selectedProfile = (selectedProfileScope === "inventory" ? inventory : devices).find(device => device.id === selectedProfileId);
  const applyScan = (candidates, selections) => {
    try {
      const result = applyNmapReview(inventory, candidates, selections);
      serializeLab(devices, connections, canvasView, result.inventory);
      setInventory(result.inventory); setWorkspace("inventory"); setActiveFirewallId(null); setNmapImportOpen(false); setLocalDiscoveryResult(null);
      setFileMessage({ kind: "success", text: `Scan imported: ${result.added} new assets, ${result.updated} matched assets reviewed. No lab devices or cables changed. Export to keep your inventory.` });
      return {};
    } catch (error) { return { error: error.message }; }
  };
  const copyToPractice = (assets) => {
    try {
      const copies = practiceCopies(assets, devices).map(device => BLUETOOTH_TYPES.has(device.type) ? { ...device, btMac: makeBtMac() } : device);
      serializeLab([...devices, ...copies], connections, canvasView, inventory);
      setDevices(previous => [...previous, ...copies]); setWorkspace("lab"); setActiveFirewallId(null);
      setFileMessage({ kind: "success", text: `${copies.length} practice copies added. Review IP prefixes (/24 is the lab default), connect cables, and configure routes. No real devices were changed.` });
      return {};
    } catch (error) { return { error: error.message }; }
  };

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-logo">⬡</span>
        <h1 className="app-title">Network Lab</h1>
        <span className="app-subtitle">Interactive Network Simulator</span>
        <nav className="workspace-tabs" aria-label="Workspace"><button className={workspace === "lab" ? "active" : ""} onClick={() => setWorkspace("lab")} disabled={firewallPending || profilePending}>Lab</button><button className={workspace === "inventory" ? "active" : ""} onClick={() => { setWorkspace("inventory"); setActiveFirewallId(null); }} disabled={firewallPending || profilePending}>Inventory ({inventory.length})</button></nav>
        <div className="lab-file-actions">
          <span className={`lab-save-status${hasUnexportedChanges ? " dirty" : ""}`}>
            {hasUnexportedChanges ? "Unexported changes" : "No unexported changes"}
          </span>
          <button className="lab-file-button" onClick={exportLab} disabled={firewallPending || profilePending} title={firewallPending || profilePending ? "Save or discard pending settings before exporting" : "Download your lab as JSON"}>Export lab</button>
          <button className="lab-file-button" onClick={() => importInputRef.current?.click()} disabled={importing}>
            {importing ? "Importing…" : "Import lab"}
          </button>
          <button className="lab-file-button" disabled={importing || firewallPending || profilePending} onClick={() => setNmapImportOpen(true)}>Import Nmap scan</button>
          <button className="lab-file-button" disabled={importing || firewallPending || profilePending} onClick={() => setDiscoveryOpen(true)}>Discover local network</button>
          <input ref={importInputRef} type="file" accept=".json,application/json" aria-label="Import lab JSON file" hidden onChange={importLab} />
        </div>
      </header>
      <div className="lab-file-notice">
        Export your lab and inventory before closing or refreshing. They are not saved automatically.
        {firewallPending && <span className="lab-file-message">Apply or discard firewall settings before exporting.</span>}
        {profilePending && <span className="lab-file-message">Save or cancel profile changes before exporting.</span>}
        {(discoveryPending || (nmapImportOpen && localDiscoveryResult)) && <span className="lab-file-message">Discovery results are included in your backup only after you review and import them.</span>}
        {fileMessage && <span className={`lab-file-message ${fileMessage.kind}`} role={fileMessage.kind === "error" ? "alert" : "status"}>{fileMessage.text}</span>}
      </div>

      <div className="app-body">
        {workspace === "inventory" && <InventoryWorkspace assets={inventory} onImport={() => setNmapImportOpen(true)} onDiscover={() => setDiscoveryOpen(true)}
          onEdit={id => { setSelectedProfileScope("inventory"); setSelectedProfileId(id); }}
          onCopy={copyToPractice} onBack={() => setWorkspace("lab")} />}
        {activeFirewall && <FirewallDashboard
          key={`${labSession}-${activeFirewall.id}`}
          device={activeFirewall} devices={devices} connections={connections}
          logs={firewallLogs.filter(event => event.firewallId === activeFirewall.id)}
          onUpdateDevice={updateDevice} onBack={() => setActiveFirewallId(null)}
          onPendingChange={setFirewallPending}
          onClearLogs={() => setFirewallLogs(previous => previous.filter(event => event.firewallId !== activeFirewall.id))}
          onDiagnosticResult={(result) => {
            appendFirewallLogs(result.firewallLogs);
            applyTrafficPackets(result.packets || []);
            (result.deviceUpdates || []).forEach(update => updateDevice(update.id, update));
          }}
        />}
        <div className="panel panel-canvas" style={activeFirewall || workspace !== "lab" ? { display: "none" } : undefined}>
          <div className="panel-label">TOPOLOGY</div>
          <NetworkCanvas
            key={labSession}
            initialView={canvasView}
            onViewChange={setCanvasView}
            devices={devices}
            connections={connections}
            trafficStats={trafficStats}
            ipTrafficStats={ipTrafficStats}
            linkTrafficStats={linkTrafficStats}
            packetFlights={packetFlights}
            onAddDevice={addDevice}
            onUpdateDevice={updateDevice}
            onRemoveDevice={removeDevice}
            onAddConnection={addConnection}
            onRemoveConnection={removeConnection}
            onUpdateConnection={updateConnection}
            onOpenFirewall={setActiveFirewallId}
            onEditProfile={id => { setSelectedProfileScope("lab"); setSelectedProfileId(id); }}
          />
        </div>
      </div>

      {/* Bottom panel toolbar */}
      <div className={`panel-bottom ${rightPanelOpen ? "expanded" : "collapsed"}`} style={workspace !== "lab" ? { display: "none" } : undefined}>
        <button
          className="panel-bottom-toggle"
          onClick={() => setRightPanelOpen((prev) => !prev)}
          title={rightPanelOpen ? "Hide terminal & packet log" : "Show terminal & packet log"}
        >
          {rightPanelOpen ? "▲" : "▼"}
        </button>

        {rightPanelOpen && (
          <div className="panel-bottom-content">
            <div className="panel panel-terminal">
              <div className="panel-label">TERMINAL</div>
              <Terminal
                key={labSession}
                devices={devices}
                connections={connections}
                packets={capturedPackets}
                onAppendPackets={appendCapturedPackets}
                onClearPackets={clearCapturedPackets}
                onShowPackets={showCapturedPackets}
                onTrafficGenerated={applyTrafficPackets}
                onUpdateDevice={updateDevice}
                onFirewallLogs={appendFirewallLogs}
              />
            </div>

            <div className="panel panel-packetlog">
              <div className="panel-label">PACKET LOG</div>
              <PacketLog packets={displayedPackets} />
            </div>
          </div>
        )}
      </div>
      {selectedProfile && <DeviceProfile key={`${labSession}-${selectedProfile.id}`}
        device={selectedProfile} context={selectedProfileScope} onPendingChange={setProfilePending}
        onSave={draft => saveDeviceProfile(selectedProfile.id, draft)}
        onClose={() => { setSelectedProfileId(null); setProfilePending(false); }}
      />}
      {nmapImportOpen && <NmapImport inventory={inventory} localResult={localDiscoveryResult} onApply={applyScan} onClose={() => { setNmapImportOpen(false); setLocalDiscoveryResult(null); }} />}
      {discoveryOpen && <LocalDiscovery onPendingChange={setDiscoveryPending}
        onClose={() => setDiscoveryOpen(false)}
        onImportXml={() => { setDiscoveryOpen(false); setLocalDiscoveryResult(null); setNmapImportOpen(true); }}
        onReview={result => { setLocalDiscoveryResult(result); setDiscoveryOpen(false); setNmapImportOpen(true); }}
      />}
    </div>
  );
}
