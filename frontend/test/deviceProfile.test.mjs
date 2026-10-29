import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfileUpdate, profileDraft, recordObservation, validateInventory, commandTokens, deviceCommandName } from '../src/deviceProfile.mjs';
import { serializeLab, parseLab, DEFAULT_VIEW } from '../src/labFile.mjs';
const pc = () => ({ id: '1', name: 'PC-1', type: 'pc', ip: '10.0.0.10/24', x: 40, y: 50, mac: '02:00:00:00:00:01', routes: [{ network: '0.0.0.0/0', via: '10.0.0.1' }] });
const server = () => ({ id: '2', name: 'Server', type: 'server', ip: '10.0.0.20', x: 200, y: 50 });
const observation = (fields = {}) => ({ source: 'nmap-import', observedAt: '2026-10-28T12:00:00.000Z', hostname: 'discovered-pc', ip: '10.0.0.11', suggestedType: 'laptop', confidence: 0.6, evidence: ['Hostname reported by DNS'], ...fields });

test('editing a profile preserves its stable ID, position, routes, and observations', () => {
  const original = recordObservation(pc(), observation());
  const result = buildProfileUpdate(original, { ...profileDraft(original), name: 'Office PC', notes: 'Desk near the window.' }, [original, server()]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.device.id, '1');
  assert.equal(result.device.x, 40);
  assert.deepEqual(result.device.routes, original.routes);
  assert.deepEqual(result.device.discovery, original.discovery);
  assert.equal(result.device.profile.overrides.name, true);
  assert.equal(result.device.profile.notes, 'Desk near the window.');
});

test('ambiguous names, control characters, invalid addresses, and duplicate IPs are rejected', () => {
  for (const patch of [{ name: 'server' }, { name: '2' }, { name: '' }, { name: 'PC\nName' }, { ip: '10.0.0.999' }, { ip: '10.0.0.20/24' }, { notes: 'x'.repeat(4001) }]) {
    const original = pc();
    assert.ok(buildProfileUpdate(original, { ...profileDraft(original), ...patch }, [original, server()]).errors.length);
  }
});

test('peripheral conversion clears IP routing and learned state without deleting observations', () => {
  const original = recordObservation({ ...pc(), arp_table: { old: 'mac' }, mac_table: { old: 'port' } }, observation());
  const result = buildProfileUpdate(original, { ...profileDraft(original), type: 'usb-storage' }, [original]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.device.ip, '');
  assert.equal(result.device.mac, '');
  assert.deepEqual(result.device.routes, []);
  assert.equal(result.device.arp_table, undefined);
  assert.equal(result.device.mac_table, undefined);
  assert.deepEqual(result.device.discovery, original.discovery);
});

test('firewall conversion preserves compatible profiles and removes incompatible firewall settings', () => {
  const original = { ...pc(), type: 'firewall', firewallEnabled: true, firewallVersion: 1, interfaces: [{ enabled: true }], rules: [{}], nat: [] };
  assert.ok(buildProfileUpdate(original, { ...profileDraft(original), ip: '10.0.0.1' }, [original]).errors.length);
  const changed = buildProfileUpdate(original, { ...profileDraft(original), type: 'server' }, [original]).device;
  assert.equal(changed.interfaces, undefined);
  assert.equal(changed.firewallEnabled, undefined);
  assert.equal(changed.id, original.id);
  const firewall = buildProfileUpdate(pc(), { ...profileDraft(pc()), type: 'firewall' }, [pc()]).device;
  assert.deepEqual(firewall.interfaces, []);
  assert.deepEqual(firewall.rules, []);
});

test('a new observation never overwrites configured names, types, IPs, notes, or overrides', () => {
  const original = { ...pc(), name: 'Office PC', profile: { notes: 'My computer', overrides: { name: true, type: true, ip: true } } };
  const updated = recordObservation(original, observation());
  assert.equal(updated.name, 'Office PC');
  assert.equal(updated.type, 'pc');
  assert.equal(updated.ip, '10.0.0.10/24');
  assert.deepEqual(updated.profile, original.profile);
  assert.equal(original.discovery, undefined);
  assert.equal(updated.discovery.observations[0].ip, '10.0.0.11');
});

test('observation history is ordered, deduplicated, and bounded', () => {
  let device = pc();
  for (let i = 0; i < 105; i++) device = recordObservation(device, observation({ observedAt: new Date(Date.UTC(2026, 9, 28, 12, i)).toISOString() }));
  assert.equal(device.discovery.observations.length, 100);
  assert.equal(device.discovery.firstSeen, '2026-10-28T12:00:00.000Z');
  const latest = device.discovery.observations.at(-1);
  device = recordObservation(device, { ...latest, hostname: 'updated' });
  assert.equal(device.discovery.observations.length, 100);
  assert.equal(device.discovery.observations.at(-1).hostname, 'updated');
});

test('invalid provenance, confidence, notes, and evidence are rejected', () => {
  for (const patch of [{ source: '' }, { observedAt: 'yesterday' }, { ip: '10.0.0.999' }, { confidence: 2 }, { confidence: NaN }, { evidence: [42] }]) assert.throws(() => recordObservation(pc(), observation(patch)));
  assert.ok(validateInventory({ profile: { notes: {} } }).length);
  assert.ok(validateInventory({ profile: { overrides: { name: 'yes' } } }).length);
});

test('JSON backup preserves profiles, observations, overrides, and device references; older files still load', () => {
  const original = recordObservation({ ...pc(), profile: { notes: 'Office', overrides: { name: true } } }, observation());
  const links = [{ from: '1', to: '2' }];
  const text = serializeLab([original, server()], links, DEFAULT_VIEW);
  const restored = parseLab(text);
  assert.deepEqual(restored.devices[0].profile, original.profile);
  assert.deepEqual(restored.devices[0].discovery, original.discovery);
  assert.deepEqual(restored.connections, links);
  const file = JSON.parse(text); file.devices[0].discovery.observations[0].confidence = 'high';
  assert.throws(() => parseLab(JSON.stringify(file)), /confidence/);
  assert.equal(parseLab(serializeLab([pc()], [], DEFAULT_VIEW)).devices[0].profile, undefined);
});

test('human readable names round trip through quoted commands', () => {
  for (const name of ['Office PC', "Dad's Laptop", 'PC "Blue"', 'Work\\Home', 'PC-1']) {
    assert.deepEqual(commandTokens(`ssh ${deviceCommandName(name)}`), ['ssh', name]);
    assert.deepEqual(commandTokens(`ping ${deviceCommandName(name)} -c 2`), ['ping', name, '-c', '2']);
  }
  assert.deepEqual(commandTokens('ssh "Office PC" via "Lab Firewall"'), ['ssh', 'Office PC', 'via', 'Lab Firewall']);
  assert.throws(() => commandTokens('ssh "Office PC'), /quote/);
});
