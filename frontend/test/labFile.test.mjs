import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VIEW, MAX_LAB_FILE_BYTES, parseLab, serializeLab, labConfiguration, configurationSignature } from '../src/labFile.mjs';

const devices = [
  { id: '1', name: 'PC-1', type: 'pc', x: 10, y: 20, ip: '10.0.0.1/24', mac: '02:00:00:00:00:01', routes: [{ network: '0.0.0.0/0', via: '10.0.0.254' }], arp_table: { '10.0.0.254': 'old' } },
  { id: 'fw', name: 'Firewall', type: 'firewall', x: -20, y: 200, ip: '',
    interfaces: [{ id: 'lan', name: 'LAN', address: '10.0.0.254/24', neighborId: '1', enabled: true }], rules: [{ id: 'rule1', interfaceId: 'lan', enabled: true, action: 'pass', protocol: 'ICMP', source: 'interface-net', destination: 'any', description: 'LAN ping' }], nat: [{ source: '10.0.0.0/24' }], mac_table: { old: 'old-port' } },
];
const connections = [{ from: '1', to: 'fw', direction: 'both', transport: 'cat', conditions: { lossPct: 2, latencyMs: 10, blocked: false } }];
const view = { scale: 1.5, pan: { x: -60, y: 180 }, expandedDevices: { fw: true } };
const backup = () => JSON.parse(serializeLab(devices, connections, view));

test('versioned backup round trips topology, routes, future firewall configuration, and view', () => {
  const text = serializeLab(devices, connections, view);
  const file = JSON.parse(text);
  assert.equal(file.format, 'network-lab');
  assert.equal(file.version, 1);
  assert.ok(file.exportedAt);
  const restored = parseLab(text);
  assert.deepEqual(restored, labConfiguration(devices, connections, view));
  assert.deepEqual(restored.devices[1].rules, devices[1].rules);
  assert.deepEqual(restored.devices[1].interfaces, devices[1].interfaces);
  assert.deepEqual(restored.devices[1].nat, devices[1].nat);
  assert.equal(restored.devices[0].arp_table, undefined);
  assert.equal(restored.devices[1].mac_table, undefined);
});

test('empty labs can be backed up and missing optional view uses defaults', () => {
  const data = { format: 'network-lab', version: 1, devices: [], connections: [] };
  assert.deepEqual(parseLab(JSON.stringify(data)).view, DEFAULT_VIEW);
  assert.equal(parseLab(serializeLab([], [], DEFAULT_VIEW)).devices.length, 0);
});

test('malformed JSON, unrelated files, and unsupported versions are rejected', () => {
  for (const text of ['{', 'null', '[]', '{}', JSON.stringify({ ...backup(), version: 2 })]) {
    assert.throws(() => parseLab(text));
  }
});

test('invalid device records and routes are rejected', () => {
  for (const mutate of [
    d => d.devices.push({ ...d.devices[0] }),
    d => { d.devices[0].id = '__proto__'; },
    d => { d.devices[0].name = 1; },
    d => { d.devices[0].x = '12'; },
    d => { d.devices[0].routes = [{}]; },
    d => { d.devices[0].ip = {}; },
    d => { d.devices = {}; },
  ]) {
    const data = backup(); mutate(data);
    assert.throws(() => parseLab(JSON.stringify(data)));
  }
});

test('dangling, self, duplicate, or invalid links are rejected', () => {
  for (const mutate of [
    d => { d.connections[0].to = 'deleted'; },
    d => { d.connections[0].to = '1'; },
    d => { d.connections.push({ from: 'fw', to: '1' }); },
    d => { d.connections[0].direction = 'wrong'; },
    d => { d.connections[0].transport = 'wrong'; },
    d => { d.connections[0].conditions.lossPct = 101; },
    d => { d.connections[0].conditions.blocked = 'false'; },
    d => { d.connections[0].conditions = []; },
  ]) {
    const data = backup(); mutate(data);
    assert.throws(() => parseLab(JSON.stringify(data)));
  }
});

test('bad view settings and prototype properties are rejected', () => {
  for (const view of [{ ...DEFAULT_VIEW, scale: 0 }, { ...DEFAULT_VIEW, pan: {} },
    { ...DEFAULT_VIEW, expandedDevices: { missing: true } }, { ...DEFAULT_VIEW, expandedDevices: [] }]) {
    assert.throws(() => parseLab(JSON.stringify({ ...backup(), view })));
  }
  assert.throws(() => parseLab(JSON.stringify(backup()).replace('"format":', '"__proto__":{},"format":')));
});

test('file limits apply to imports and exports', () => {
  assert.throws(() => parseLab(' '.repeat(MAX_LAB_FILE_BYTES + 1)), /5 MB/);
  assert.throws(() => serializeLab([{ ...devices[0], name: '' }], [], DEFAULT_VIEW));
});

test('dirty comparison ignores learned state, JSON key order, and removed expansion entries', () => {
  const config = labConfiguration(devices, connections, view);
  const changedRuntime = devices.map(d => ({ ...d, arp_table: { learned: 'new' }, mac_table: { new: 'port' } }));
  assert.equal(configurationSignature(config), configurationSignature(labConfiguration(changedRuntime, connections, view)));
  assert.equal(configurationSignature(config), configurationSignature({ view: config.view, connections: config.connections, devices: config.devices }));
  assert.deepEqual(labConfiguration([], [], view).view.expandedDevices, {});
  assert.notEqual(configurationSignature(config), configurationSignature(labConfiguration(devices.map(d => ({ ...d, x: d.x + 1 })), connections, view)));
});
