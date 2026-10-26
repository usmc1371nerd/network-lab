export function ipv4Network(value) {
  if (typeof value !== "string") return null;
  const [host, prefixText, extra] = value.split("/");
  const parts = host.split(".");
  const prefix = prefixText === undefined ? 32 : Number(prefixText);
  if (extra !== undefined || parts.length !== 4 || parts.some(p => !/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255)
      || (prefixText !== undefined && !/^(0|[1-9]\d?)$/.test(prefixText))
      || prefixText === "" || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const address = parts.reduce((n, p) => (n * 256 + Number(p)) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { address, prefix, network: (address & mask) >>> 0, mask };
}

export function validateFirewall(config, neighborIds) {
  const errors = [];
  if (!Array.isArray(config.interfaces) || !Array.isArray(config.rules)) return ["Interfaces and rules must be arrays."];
  if (config.interfaces.length > 32 || config.rules.length > 200) return ["Use at most 32 interfaces and 200 rules."];
  const ids = new Set(), names = new Set(), neighbors = new Set(), networks = [];
  for (const item of config.interfaces) {
    if (!item || typeof item.id !== "string" || !/^[\w-]{1,100}$/.test(item.id) || ids.has(item.id)) {
      errors.push("Each interface needs a unique ID."); continue;
    }
    ids.add(item.id);
    if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 32 || names.has(item.name.toUpperCase())) errors.push("Interface names must be nonempty and unique.");
    names.add(String(item.name).toUpperCase());
    if (typeof item.enabled !== "boolean") errors.push("Choose whether each interface is enabled.");
    if (!item.enabled) continue;
    if (typeof item.neighborId !== "string" || !item.neighborId || neighbors.has(item.neighborId)
        || (neighborIds && !neighborIds.includes(item.neighborId))) errors.push("Assign each enabled interface to a different connected device.");
    neighbors.add(item.neighborId);
    const network = ipv4Network(item.address);
    if (!network || !item.address.includes("/")) errors.push(`${item.name}: enter an IPv4 interface address with a prefix, such as 10.10.10.1/24.`);
    else {
      const broadcast = (network.network | (~network.mask >>> 0)) >>> 0;
      if (network.prefix < 31 && (network.address === network.network || network.address === broadcast)) errors.push(`${item.name}: use a host address, not the subnet or broadcast address.`);
      if (networks.some(n => ((network.address & n.mask) >>> 0) === n.network || ((n.address & network.mask) >>> 0) === network.network)) errors.push("Enabled firewall interfaces must use different, non-overlapping subnets.");
      networks.push(network);
    }
  }
  if (config.firewallEnabled && networks.length === 0) errors.push("Assign at least one enabled interface before enabling filtering.");
  const ruleIds = new Set();
  for (const rule of config.rules) {
    if (!rule || typeof rule.id !== "string" || ruleIds.has(rule.id)) { errors.push("Rules need unique IDs."); continue; }
    ruleIds.add(rule.id);
    if (!ids.has(rule.interfaceId)) errors.push("Assign every rule to an interface.");
    if (!["pass", "block"].includes(rule.action) || !["any", "ICMP"].includes(rule.protocol)) errors.push("Rules support Pass/Block and Any/ICMP.");
    if (typeof rule.enabled !== "boolean" || typeof rule.description !== "string" || rule.description.length > 200) errors.push("Invalid rule description or enabled flag.");
    for (const token of [rule.source, rule.destination]) {
      if (!["any", "interface-net"].includes(token) && !ipv4Network(token)) errors.push("Rule addresses must be any, interface-net, an IPv4 address, or a CIDR subnet.");
    }
  }
  return [...new Set(errors)];
}
