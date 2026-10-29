import { ipv4Network } from "./firewallConfig.mjs";
import { recordObservation, NON_IP_TYPES } from "./deviceProfile.mjs";

export const MAX_NMAP_BYTES = 5 * 1024 * 1024;
const children = (element, tag) => Array.from(element.childNodes || []).filter(node => node.nodeType === 1 && node.tagName === tag);
const descendants = (element, tag) => Array.from(element.getElementsByTagName(tag));
const attr = (element, key, max = 200) => (element?.getAttribute(key) || "").trim().slice(0, max);
const latest = asset => [...(asset.discovery?.observations || [])].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
const mac = value => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value || "") && value !== "00:00:00:00:00:00" && !(parseInt(value.slice(0, 2), 16) & 1) ? value.toLowerCase() : "";
const typeMap = { router: "router", switch: "switch", firewall: "firewall", printer: "printer", phone: "phone", "WAP": "ap", "wireless access point": "ap" };
const time = value => {
  if (!/^\d{1,12}$/.test(value || "")) return null;
  const date = new Date(Number(value) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export function parseNmapXml(text, { parseXml, sourceFile = "Nmap XML", fallbackTime = new Date().toISOString() } = {}) {
  if (new TextEncoder().encode(text).length > MAX_NMAP_BYTES) throw new Error("Nmap XML files must be 5 MB or smaller.");
  // A plain Nmap DOCTYPE is common. External DTDs and entity declarations are unnecessary.
  if (/<!ENTITY/i.test(text) || /<!DOCTYPE(?!\s+nmaprun\s*>)/i.test(text)) throw new Error("External DTDs and custom XML entities are not supported. Use standard Nmap XML output.");
  let document;
  try { document = parseXml ? parseXml(text) : new DOMParser().parseFromString(text, "application/xml"); }
  catch { throw new Error("The XML file is malformed."); }
  const root = document?.documentElement;
  if (!root || root.tagName === "parsererror" || descendants(root, "parsererror").length) throw new Error("The XML file is malformed.");
  if (root.tagName !== "nmaprun" || (attr(root, "scanner") && attr(root, "scanner") !== "nmap")) throw new Error("Choose an Nmap XML file with an nmaprun root element.");
  const finished = descendants(root, "finished")[0];
  if (attr(finished, "exit") === "error") throw new Error("This scan reports an error. Choose a completed Nmap scan.");
  const hosts = children(root, "host");
  if (hosts.length > 1000) throw new Error("This import supports at most 1,000 host records per scan.");
  if (!Number.isFinite(Date.parse(fallbackTime))) throw new Error("Invalid import timestamp.");
  const candidates = [], warnings = [], seen = new Set();
  const skipped = { notUp: 0, unsupported: 0, duplicate: 0 };
  for (const host of hosts) {
    const status = children(host, "status")[0];
    if (attr(status, "state") !== "up") { skipped.notUp++; continue; }
    const addresses = children(host, "address");
    const ipv4 = addresses.filter(node => attr(node, "addrtype") === "ipv4").map(node => attr(node, "addr"))
      .find(value => !value.includes("/") && ipv4Network(value));
    if (!ipv4) { skipped.unsupported++; continue; }
    if (seen.has(ipv4)) { skipped.duplicate++; warnings.push(`Repeated IPv4 record ${ipv4}: only the first record is shown.`); continue; }
    seen.add(ipv4);
    const hardware = addresses.find(node => attr(node, "addrtype") === "mac");
    const hostname = attr(descendants(host, "hostname")[0], "name");
    const evidence = [];
    let observedAt = time(attr(host, "endtime")), timestampSource = "host-end";
    if (!observedAt) { observedAt = time(attr(finished, "time")); timestampSource = "scan-finished"; }
    if (!observedAt) { observedAt = time(attr(root, "start")); timestampSource = "scan-start"; }
    if (!observedAt) { observedAt = new Date(fallbackTime).toISOString(); timestampSource = "import-time"; evidence.push("Scan timestamp unavailable; the import time is used."); }
    const classes = children(host, "os").flatMap(node => descendants(node, "osclass")).sort((a, b) => Number(attr(b, "accuracy")) - Number(attr(a, "accuracy")));
    const classification = classes[0];
    const reportedType = attr(classification, "type");
    const suggestedType = typeMap[reportedType] || "unknown";
    const accuracy = Number(attr(classification, "accuracy"));
    if (reportedType) evidence.push(`Nmap reported device class: ${reportedType}. This is a suggestion, not a confirmed type.`);
    const os = attr(descendants(host, "osmatch")[0], "name");
    if (os) evidence.push(`Nmap OS fingerprint: ${os}.`);
    const ports = children(host, "ports").flatMap(node => children(node, "port"));
    if (ports.length > 128) warnings.push(`${ipv4}: only the first 128 individual port records are kept.`);
    const services = ports.slice(0, 128).flatMap(port => {
      const number = Number(attr(port, "portid"));
      const protocol = attr(port, "protocol"), state = attr(children(port, "state")[0], "state");
      if (!/^\d+$/.test(attr(port, "portid")) || !Number.isInteger(number) || number < 0 || number > 65535 || !["tcp", "udp", "sctp", "ip"].includes(protocol)) return [];
      const service = children(port, "service")[0];
      return [{ port: number, protocol, state: state || "unknown", name: attr(service, "name"), product: attr(service, "product"), version: attr(service, "version"), method: attr(service, "method") }];
    });
    const observation = {
      source: "Nmap XML", sourceFile: sourceFile.slice(0, 200), observedAt, timestampSource,
      ip: ipv4, hostname, mac: mac(attr(hardware, "addr")), vendor: attr(hardware, "vendor"),
      suggestedType, ...(classification && suggestedType !== "unknown" && attr(classification, "accuracy") && accuracy >= 0 && accuracy <= 100 ? { confidence: accuracy / 100 } : {}),
      evidence, services, ...(os ? { os } : {}),
    };
    candidates.push({ key: ipv4, defaultName: hostname || `Device ${ipv4}`, observation });
  }
  const macCounts = new Map();
  candidates.forEach(c => { if (c.observation.mac) macCounts.set(c.observation.mac, (macCounts.get(c.observation.mac) || 0) + 1); });
  for (const candidate of candidates) candidate.sharedMac = Boolean(candidate.observation.mac && macCounts.get(candidate.observation.mac) > 1);
  return { candidates, warnings, skipped, sourceFile, scannerVersion: attr(root, "version"), hostCount: hosts.length };
}

export function suggestInventoryMatch(candidate, inventory) {
  const observed = candidate.observation;
  const byMac = observed.mac ? inventory.filter(asset => mac(latest(asset)?.mac) === observed.mac) : [];
  const byIp = inventory.filter(asset => latest(asset)?.ip === observed.ip);
  if (candidate.sharedMac || byMac.length > 1) return { selected: false, targetId: "new", reason: "Shared MAC: review identity before adding." };
  if (byMac.length === 1) return { selected: true, targetId: byMac[0].id, reason: "Suggested match by observed MAC. Confirm the identity." };
  if (byIp.length) return { selected: false, targetId: byIp.length === 1 && !observed.mac ? byIp[0].id : "new", reason: "Address seen before: IP alone does not confirm identity. Review before importing." };
  return { selected: true, targetId: "new", reason: "New inventory asset. Type remains unknown until you confirm it." };
}

function uniqueName(name, assets) {
  const base = name.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 180) || "Discovered device";
  const used = new Set(assets.flatMap(asset => [asset.name.toLowerCase(), asset.id.toLowerCase()]));
  let result = base, suffix = 2;
  while (used.has(result.toLowerCase())) result = `${base} (${suffix++})`;
  return result;
}

export function applyNmapReview(inventory, candidates, selections, idFactory = () => crypto.randomUUID()) {
  const result = [...inventory], candidateMap = new Map(candidates.map(candidate => [candidate.key, candidate]));
  const updatedIds = new Set();
  let added = 0, updated = 0;
  for (const row of selections.filter(row => row.selected)) {
    const candidate = candidateMap.get(row.key);
    if (!candidate) throw new Error("An import row no longer matches the scan.");
    if (row.targetId !== "new") {
      const index = result.findIndex(asset => asset.id === row.targetId);
      if (index < 0) throw new Error("The selected inventory asset no longer exists.");
      result[index] = recordObservation(result[index], candidate.observation);
      updatedIds.add(row.targetId);
    } else {
      const id = `asset-${idFactory()}`;
      if (result.some(asset => asset.id === id)) throw new Error("A generated inventory ID already exists. Retry the import.");
      result.push(recordObservation({ id, name: uniqueName(candidate.defaultName, result), type: "unknown", ip: "", x: 0, y: 0,
        profile: { notes: "", overrides: { name: false, type: false, ip: false } },
      }, candidate.observation));
      added++;
    }
  }
  if (result.length > 1000) throw new Error("The inventory supports at most 1,000 assets.");
  updated = updatedIds.size;
  return { inventory: result, added, updated };
}

export function practiceCopies(assets, labDevices, idFactory = () => crypto.randomUUID()) {
  if (labDevices.length + assets.length > 1000) throw new Error("The practice lab supports at most 1,000 devices.");
  const result = [...labDevices], copies = [];
  const usedIps = new Set(labDevices.flatMap(device => [device.ip, ...(device.interfaces || []).map(i => i.address)]).filter(Boolean).map(ip => ip.split("/")[0]));
  for (const asset of assets) {
    let ip = NON_IP_TYPES.has(asset.type) ? "" : asset.ip || latest(asset)?.ip || "";
    if (ip && !ip.includes("/")) ip += "/24"; // Explicit lab default, not a discovered subnet mask.
    if (ip && usedIps.has(ip.split("/")[0])) throw new Error(`The lab already contains ${ip.split("/")[0]}. Set a different lab IPv4 override in the inventory profile first.`);
    if (ip) usedIps.add(ip.split("/")[0]);
    const id = `lab-${idFactory()}`;
    if (result.some(device => device.id === id)) throw new Error("A generated lab ID already exists. Retry the copy.");
    const copy = { ...asset, id, name: uniqueName(asset.name, result), ip, x: 40 + (result.length % 4) * 260, y: 40 + Math.floor(result.length / 4) * 230,
      routes: [], mac: "", profile: { ...asset.profile, overrides: { ...asset.profile?.overrides } }, practiceSourceId: asset.id,
    };
    delete copy.arp_table; delete copy.mac_table;
    // Observed identities stay in discovery; copies do not import live policy or sessions.
    if (copy.type === "firewall") Object.assign(copy, { interfaces: [], rules: [], nat: [], firewallEnabled: false });
    result.push(copy); copies.push(copy);
  }
  return copies;
}

export const latestObservation = latest;

export function withLocalDiscoveryContext(scan, result) {
  const neighbors = new Map((result.neighbors || []).map(neighbor => [neighbor.ip, mac(neighbor.mac)]));
  const scope = ipv4Network(result.network.cidr);
  if (!scope) throw new Error("The local discovery scope is invalid.");
  const broadcast = (scope.network | (~scope.mask >>> 0)) >>> 0;
  const eligible = scan.candidates.filter(candidate => {
    const address = ipv4Network(candidate.observation.ip)?.address;
    return address !== undefined && ((address & scope.mask) >>> 0) === scope.network
      && (scope.prefix >= 31 || (address !== scope.network && address !== broadcast));
  });
  const candidates = eligible.map(candidate => {
      const observation = { ...candidate.observation, evidence: [...candidate.observation.evidence], source: "Local discovery (Nmap)",
        localInterface: result.network.interface, localNetwork: result.network.cidr, gateway: result.network.gateway || "" };
      if (!observation.mac && neighbors.get(observation.ip)) {
        observation.mac = neighbors.get(observation.ip);
        observation.hardwareSource = "Linux neighbor cache";
        observation.evidence.push("MAC reported by Linux neighbor cache (may be cached).");
      }
      return { ...candidate, observation };
    });
  const counts = new Map();
  candidates.forEach(candidate => { if (candidate.observation.mac) counts.set(candidate.observation.mac, (counts.get(candidate.observation.mac) || 0) + 1); });
  candidates.forEach(candidate => { candidate.sharedMac = candidate.sharedMac || Boolean(candidate.observation.mac && counts.get(candidate.observation.mac) > 1); });
  const omitted = scan.candidates.length - candidates.length;
  return { ...scan, isLocal: true, candidates, warnings: [...scan.warnings, ...(omitted ? [`${omitted} out-of-scope or network/broadcast address records omitted.`] : [])] };
}
