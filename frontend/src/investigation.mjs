import { ipv4Network } from './firewallConfig.mjs';
import { latestObservation, parseNmapXml, withLocalDiscoveryContext } from './nmapImport.mjs';

const services = {
  ssh: 'Remote terminal access. Signing in requires an account and permission.',
  http: 'Web content or a management page. HTTP does not encrypt the connection.',
  https: 'Encrypted web content or a management page. A scan does not verify its certificate or safety.',
  domain: 'DNS translates names into network addresses.',
  'microsoft-ds': 'SMB is commonly used for shared files and printers.',
  'ms-wbt-server': 'Remote Desktop provides a graphical remote session.',
  ipp: 'Internet Printing Protocol is commonly used by network printers.',
  smtp: 'Mail transfer between systems.',
  snmp: 'Network monitoring and management. A scan does not establish which permissions are available.',
  ntp: 'Clock synchronization.',
  mqtt: 'Messaging often used by sensors and home automation.',
};
const ports = { 22: 'ssh', 80: 'http', 443: 'https', 53: 'domain', 445: 'microsoft-ds', 3389: 'ms-wbt-server', 631: 'ipp', 25: 'smtp', 161: 'snmp', 123: 'ntp', 1883: 'mqtt' };
export function explainService(service) {
  const states = {
    open: 'The scan reported a service accepting traffic on this port.',
    closed: 'The scan reached the address, but reported no service listening on this port.',
    filtered: 'The scanner could not determine whether this port was open; filtering may have blocked its probes.',
    'open|filtered': 'The scanner could not distinguish an open port from filtered traffic.',
    'closed|filtered': 'The scanner could not distinguish a closed port from filtered traffic.',
    unfiltered: 'The port responded to the probe, but this scan did not determine whether it was open.',
  };
  const label = String(service.name || '').toLowerCase();
  const guessed = !Object.hasOwn(services, label);
  const common = guessed ? services[ports[service.port]] : services[label];
  return {
    state: states[service.state] || `The scan reported “${service.state}”; its meaning depends on the scan method.`,
    purpose: common ? `${guessed ? 'This port is commonly associated with: ' : ''}${common}` : 'The purpose is not known from this record. Confirm it in the device documentation.',
    evidence: service.method === 'probed' ? 'Nmap reported probe-based identification; this is still saved scan evidence.' : 'The service label may come from a port-name lookup. It does not confirm which software is running.',
  };
}
export function investigationTarget(asset, networks = []) {
  const ip = latestObservation(asset)?.ip;
  const parsed = typeof ip === 'string' && !ip.includes('/') ? ipv4Network(ip) : null;
  const privateAddress = parsed && ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].some(value => {
    const parent = ipv4Network(value); return ((parsed.address & parent.mask) >>> 0) === parent.network;
  });
  const eligible = privateAddress ? networks.filter(item => {
    const subnet = ipv4Network(item.connectedCidr);
    if (!subnet || ((parsed.address & subnet.mask) >>> 0) !== subnet.network) return false;
    const broadcast = (subnet.network | (~subnet.mask >>> 0)) >>> 0;
    return subnet.prefix >= 31 || (parsed.address !== subnet.network && parsed.address !== broadcast);
  }) : [];
  return { ip: ip || '', cidr: parsed && privateAddress ? `${ip}/32` : '', networks: eligible };
}
export function summarizeResponse(asset, result, parseXml) {
  const target = investigationTarget(asset).ip;
  const scan = withLocalDiscoveryContext(parseNmapXml(result.xml, { parseXml, sourceFile: 'Local response check' }), result);
  const observation = scan.candidates.find(item => item.observation.ip === target)?.observation;
  if (!observation) return 'No response was recorded for this address. The device may be asleep, disconnected, blocking probes, or using a different address. This does not prove it is offline.';
  const previous = latestObservation(asset);
  const changed = previous?.mac && observation.mac && previous.mac.toLowerCase() !== observation.mac.toLowerCase();
  return `An address responded at ${target}. ${changed ? 'Its reported MAC differs from the saved record. Review device identity before updating this asset.' : 'A response alone does not verify device identity or whether an application works.'} MAC evidence may come from a cached neighbor entry. This host-only check does not retest saved service ports.`;
}
