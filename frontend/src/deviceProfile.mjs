import { ipv4Network } from "./firewallConfig.mjs";

export const DEVICE_TYPES = {
  unknown: "Unknown device", pc: "PC", server: "Server", printer: "Network printer", router: "Router", firewall: "Firewall",
  switch: "Switch", hub: "Hub", ap: "Access point", laptop: "Laptop", phone: "Phone", gateway: "Bluetooth gateway",
  beacon: "BLE beacon", sensor: "BLE sensor", "iot-bulb": "IoT bulb", "iot-lock": "IoT lock",
  "iot-tag": "IoT tag", "iot-camera": "IoT camera", "iot-thermostat": "IoT thermostat", "iot-plug": "IoT plug",
  "usb-storage": "USB storage", "usb-keyboard": "USB keyboard", "usb-mouse": "USB mouse",
  "usb-webcam": "USB webcam", "usb-audio": "USB audio", "usb-printer": "USB printer",
};
export const NON_IP_TYPES = new Set(["usb-storage", "usb-keyboard", "usb-mouse", "usb-webcam", "usb-audio", "usb-printer", "beacon", "sensor", "iot-tag"]);
export const BLUETOOTH_TYPES = new Set(["phone", "laptop", "gateway", "beacon", "sensor", "iot-bulb", "iot-lock", "iot-tag", "iot-camera", "iot-thermostat", "iot-plug"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max) => typeof value === "string" && value.length <= max;
const normalizedIp = value => String(value || "").split("/")[0];

export function profileDraft(device) {
  return { name: device.name, type: device.type, ip: device.ip || "", notes: device.profile?.notes || "" };
}

export function validateObservation(observation) {
  if (!object(observation) || !text(observation.source, 80) || !observation.source.trim()
      || !text(observation.observedAt, 40) || !/^\d{4}-\d\d-\d\dT/.test(observation.observedAt) || !Number.isFinite(Date.parse(observation.observedAt))) return ["Discovery observations need a source and an ISO timestamp."];
  for (const key of ["hostname", "ip", "mac", "suggestedType", "vendor", "os", "sourceFile", "timestampSource", "localInterface", "localNetwork", "gateway", "hardwareSource"]) {
    if (observation[key] !== undefined && !text(observation[key], 200)) return [`Invalid discovery ${key}.`];
  }
  if (observation.ip && !ipv4Network(observation.ip)) return ["Observed IP must be an IPv4 address."];
  if (observation.confidence !== undefined && (typeof observation.confidence !== "number" || !Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1)) return ["Discovery confidence must be between 0 and 1."];
  if (observation.evidence !== undefined && (!Array.isArray(observation.evidence) || observation.evidence.length > 20 || observation.evidence.some(item => !text(item, 500)))) return ["Discovery evidence must be a list of short descriptions."];
  if (observation.services !== undefined && (!Array.isArray(observation.services) || observation.services.length > 128 || observation.services.some(service =>
    !object(service) || !Number.isInteger(service.port) || service.port < 0 || service.port > 65535
    || !["tcp", "udp", "sctp", "ip"].includes(service.protocol) || !text(service.state, 40)
    || ["name", "product", "version", "method"].some(key => service[key] !== undefined && !text(service[key], 200))))) return ["Invalid discovery service records."];
  return [];
}

export function validateInventory(device) {
  if (device.profile !== undefined) {
    if (!object(device.profile) || (device.profile.notes !== undefined && !text(device.profile.notes, 4000))) return ["Device notes must be text, up to 4,000 characters."];
    if (device.profile.overrides !== undefined && (!object(device.profile.overrides) || Object.entries(device.profile.overrides).some(([key, value]) => !["name", "type", "ip"].includes(key) || typeof value !== "boolean"))) return ["Invalid device profile overrides."];
  }
  if (device.discovery !== undefined) {
    if (!object(device.discovery) || !Array.isArray(device.discovery.observations) || device.discovery.observations.length > 100) return ["Discovery must contain at most 100 observations."];
    for (const key of ["firstSeen", "lastSeen"]) {
      if (device.discovery[key] !== undefined && (!text(device.discovery[key], 40) || !/^\d{4}-\d\d-\d\dT/.test(device.discovery[key]) || !Number.isFinite(Date.parse(device.discovery[key])))) return ["Discovery history timestamps must use ISO format."];
    }
    for (const observation of device.discovery.observations) {
      const errors = validateObservation(observation);
      if (errors.length) return errors;
    }
  }
  return [];
}

export function buildProfileUpdate(device, draft, devices) {
  const name = String(draft.name || "").trim(), ip = String(draft.ip || "").trim();
  const errors = [];
  if (!name || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) errors.push("Enter a device name of 1–200 characters, without line breaks.");
  if (devices.some(other => other.id !== device.id && [other.name, other.id, normalizedIp(other.ip)].some(value => value && String(value).toLowerCase() === name.toLowerCase()))) errors.push("Choose a name that does not match another device's name, ID, or IP.");
  if (!Object.hasOwn(DEVICE_TYPES, draft.type)) errors.push("Choose a supported device type.");
  if (!text(draft.notes, 4000)) errors.push("Notes must be text, up to 4,000 characters.");
  const ipCapable = !NON_IP_TYPES.has(draft.type);
  if (ipCapable && ip && !ipv4Network(ip)) errors.push("Enter an IPv4 address, optionally with a prefix (for example 10.10.10.10/24).");
  if (ipCapable && ip && devices.some(other => other.id !== device.id && [other.ip, ...(Array.isArray(other.interfaces) ? other.interfaces : []).map(item => item.address)].some(address => address && normalizedIp(address) === normalizedIp(ip)))) errors.push("That IP is already configured on another device or firewall interface.");
  if (device.type === "firewall" && draft.type === "firewall" && device.interfaces?.some(item => item.enabled) && ip !== (device.ip || "")) errors.push("Change this firewall's addresses in its dashboard Interfaces page.");
  if (errors.length) return { errors };
  const overrides = { ...device.profile?.overrides };
  for (const key of ["name", "type", "ip"]) {
    if ((key === "name" ? name : key === "ip" ? ip : draft.type) !== (device[key] || "")) overrides[key] = true;
  }
  const updated = { ...device, name, type: draft.type, ip: ipCapable ? ip : "", profile: { ...device.profile, notes: draft.notes, overrides } };
  if (device.type !== updated.type || device.ip !== updated.ip) {
    updated.arp_table = {};
    delete updated.mac_table;
    if (updated.type === "switch") updated.mac_table = {};
  }
  if (device.type === "firewall" && updated.type !== "firewall") {
    for (const key of ["interfaces", "rules", "nat", "firewallEnabled", "firewallVersion"]) delete updated[key];
  }
  if (updated.type === "firewall") {
    updated.interfaces ??= []; updated.rules ??= []; updated.nat ??= [];
  }
  if (!ipCapable) { updated.mac = ""; updated.routes = []; delete updated.arp_table; }
  if (!BLUETOOTH_TYPES.has(updated.type)) delete updated.btMac;
  return { device: updated, errors: [] };
}

// Discovery adds evidence; it never rewrites the user's configured name/type/IP.
export function recordObservation(device, observation) {
  const errors = validateObservation(observation);
  if (errors.length) throw new Error(errors.join(" "));
  const observations = [...(device.discovery?.observations || [])];
  const duplicate = observations.findIndex(item => item.source === observation.source && item.observedAt === observation.observedAt && item.ip === observation.ip);
  if (duplicate >= 0) observations[duplicate] = observation;
  else observations.push(observation);
  observations.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const times = observations.map(item => Date.parse(item.observedAt));
  if (device.discovery?.firstSeen) times.push(Date.parse(device.discovery.firstSeen));
  if (device.discovery?.lastSeen) times.push(Date.parse(device.discovery.lastSeen));
  return { ...device, discovery: {
    ...device.discovery, observations: observations.slice(-100),
    firstSeen: new Date(Math.min(...times)).toISOString(), lastSeen: new Date(Math.max(...times)).toISOString(),
  } };
}

export function deviceCommandName(name) {
  return /^[A-Za-z0-9_.:-]+$/.test(name) ? name : JSON.stringify(name);
}

export function commandTokens(command) {
  const tokens = []; let token = "", quote = null, started = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      if (++index === command.length) throw new Error("Incomplete escape in command.");
      token += command[index]; started = true;
    } else if (quote) {
      if (char === quote) quote = null; else token += char;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { tokens.push(token); token = ""; started = false; } }
    else { token += char; started = true; }
  }
  if (quote) throw new Error("Close the quote around the device name.");
  if (started) tokens.push(token);
  return tokens;
}
