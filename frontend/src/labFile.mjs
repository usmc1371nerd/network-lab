import { validateFirewall } from "./firewallConfig.mjs";

export const LAB_FILE_VERSION = 1;
export const MAX_LAB_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_VIEW = { scale: 1, pan: { x: 0, y: 0 }, expandedDevices: {} };

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const fail = (message) => { throw new Error(message); };
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;

// Keep configuration extensions (including future interface/rule/NAT fields).
// Learned tables and running simulation state are intentionally not portable.
function deviceConfig(device) {
  const { arp_table, mac_table, ...configuration } = device;
  return configuration;
}

export function labConfiguration(devices, connections, view = DEFAULT_VIEW) {
  const ids = new Set(devices.map((device) => device.id));
  return {
    devices: devices.map(deviceConfig), connections,
    view: { ...view, expandedDevices: Object.fromEntries(
      Object.entries(view.expandedDevices).filter(([id, expanded]) => ids.has(id) && expanded)
    ) },
  };
}

export function configurationSignature(configuration) {
  // Object key ordering in an imported JSON file must not mark the lab as changed.
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : object(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value;
  return JSON.stringify(canonical(configuration));
}

export function serializeLab(devices, connections, view) {
  const configuration = labConfiguration(devices, connections, view);
  const text = JSON.stringify({
    format: "network-lab", version: LAB_FILE_VERSION,
    exportedAt: new Date().toISOString(), ...configuration,
  }, null, 2);
  // Never produce a backup that this version cannot restore.
  parseLab(text);
  return text;
}

export function parseLab(text) {
  if (new TextEncoder().encode(text).length > MAX_LAB_FILE_BYTES) fail("Lab files must be 5 MB or smaller.");
  let data;
  try {
    data = JSON.parse(text, (key, value) => {
      if (["__proto__", "prototype", "constructor"].includes(key)) fail("Unsupported property in lab file.");
      return value;
    });
  } catch {
    fail("This file is not valid lab JSON. Choose an exported Network Lab file.");
  }
  if (!object(data) || data.format !== "network-lab") fail("This is not a Network Lab backup.");
  if (data.version !== LAB_FILE_VERSION) fail(`Unsupported lab version: ${data.version}. This app supports version ${LAB_FILE_VERSION}.`);
  if (!Array.isArray(data.devices) || data.devices.length > 1000) fail("A lab must contain a devices array with at most 1,000 devices.");
  if (!Array.isArray(data.connections) || data.connections.length > 10000) fail("A lab must contain a connections array with at most 10,000 links.");

  const ids = new Set();
  for (const device of data.devices) {
    if (!object(device) || typeof device.id !== "string" || !idPattern.test(device.id)
        || ["__proto__", "prototype", "constructor"].includes(device.id) || ids.has(device.id)) {
      fail("Device IDs must be unique strings containing letters, numbers, underscores, or hyphens.");
    }
    ids.add(device.id);
    if (typeof device.name !== "string" || !device.name.trim() || device.name.length > 200
        || typeof device.type !== "string" || !device.type.trim() || device.type.length > 100) {
      fail("Each device needs a name and device type.");
    }
    if (![device.x, device.y].every((value) => finite(value) && Math.abs(value) <= 1e7)) fail("Device positions must be finite coordinates.");
    for (const key of ["ip", "mac", "btMac"]) {
      if (device[key] !== undefined && (typeof device[key] !== "string" || device[key].length > 200)) fail(`Device ${key} must be a string.`);
    }
    if (device.routes !== undefined && (!Array.isArray(device.routes) || device.routes.some((route) =>
      !object(route) || typeof route.network !== "string" || typeof route.via !== "string"))) {
      fail("Device routes must be an array of network/via entries.");
    }
  }

  const pairs = new Set();
  const ranges = {
    lossPct: [0, 100], latencyMs: [0, 1e7], jitterMs: [0, 1e7],
    queueLimitPkts: [1, 1e7], bandwidthPps: [1, 1e7],
    redMinTh: [0, 1e7], redMaxTh: [0, 1e7], redMaxDropPct: [0, 100],
  };
  for (const link of data.connections) {
    if (!object(link) || !ids.has(link.from) || !ids.has(link.to) || link.from === link.to) fail("Every connection must join two existing, different devices.");
    const pair = JSON.stringify([link.from, link.to].sort());
    if (pairs.has(pair)) fail("Duplicate connections are not supported.");
    pairs.add(pair);
    if (link.direction !== undefined && !["both", "forward", "reverse"].includes(link.direction)) fail("Invalid connection direction.");
    if (link.transport !== undefined && !["cat", "network", "wifi", "usb", "bluetooth"].includes(link.transport)) fail("Invalid connection type.");
    if (link.conditions !== undefined && !object(link.conditions)) fail("Link conditions must be an object.");
    for (const [key, value] of Object.entries(link.conditions || {})) {
      if (ranges[key] && (!finite(value) || value < ranges[key][0] || value > ranges[key][1])) fail(`Invalid link condition: ${key}.`);
      if (["blocked", "redEnabled"].includes(key) && typeof value !== "boolean") fail(`Invalid link condition: ${key}.`);
    }
  }

  for (const device of data.devices.filter(device => device.type === "firewall")) {
    if (device.firewallEnabled !== undefined && typeof device.firewallEnabled !== "boolean") fail("Firewall enabled flag must be a boolean.");
    if (device.firewallVersion !== undefined && device.firewallVersion !== 1) fail("Unsupported firewall configuration version.");
    const neighbors = data.connections.filter(link => link.from === device.id || link.to === device.id)
      .map(link => link.from === device.id ? link.to : link.from);
    const errors = validateFirewall({ ...device, interfaces: device.interfaces || [], rules: device.rules || [] }, neighbors);
    if (errors.length) fail(`Invalid firewall configuration: ${errors.join(" ")}`);
  }

  const view = data.view ?? DEFAULT_VIEW;
  if (!object(view) || !finite(view.scale) || view.scale < 0.3 || view.scale > 3
      || !object(view.pan) || ![view.pan.x, view.pan.y].every((value) => finite(value) && Math.abs(value) <= 1e7)
      || !object(view.expandedDevices) || Object.entries(view.expandedDevices).some(([id, value]) => !ids.has(id) || typeof value !== "boolean")) {
    fail("Invalid canvas view settings.");
  }
  return labConfiguration(data.devices, data.connections, view);
}
