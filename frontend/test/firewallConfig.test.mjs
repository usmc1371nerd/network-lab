import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFirewall, ipv4Network } from '../src/firewallConfig.mjs';
import { parseLab, serializeLab, DEFAULT_VIEW } from '../src/labFile.mjs';
const config = () => ({ firewallVersion: 1, firewallEnabled: true,
  interfaces: [{ id: 'lan', name: 'LAN', neighborId: 'pc', address: '10.10.10.1/24', enabled: true },
    { id: 'wan', name: 'WAN', neighborId: 'server', address: '10.10.30.1/24', enabled: true }],
  rules: [{ id: 'r1', interfaceId: 'lan', enabled: true, action: 'pass', protocol: 'ICMP', source: 'interface-net', destination: 'any', description: 'LAN ping' }],
});
test('valid interfaces and rule configuration can be applied', () => {
  assert.deepEqual(validateFirewall(config(), ['pc', 'server']), []);
});
test('invalid addresses and overlapping interface subnets are rejected', () => {
  for (const address of ['10.10.10.256/24', '10.10.10.1', '10.10.10.5/24', '10.10.0.1/16', '10.10.30.0/24', '10.10.30.255/24']) {
    const c = config(); c.interfaces[1].address = address;
    assert.ok(validateFirewall(c, ['pc', 'server']).length);
  }
});
test('interfaces cannot share names or cables or point to missing neighbors', () => {
  for (const patch of [{ name: 'lan' }, { neighborId: 'pc' }, { neighborId: 'gone' }]) {
    const c = config(); Object.assign(c.interfaces[1], patch);
    assert.ok(validateFirewall(c, ['pc', 'server']).length);
  }
});
test('rules require existing interfaces and supported actions, protocols, and addresses', () => {
  for (const patch of [{ interfaceId: 'gone' }, { action: 'allow' }, { protocol: 'TCP' }, { source: '10.1.1.999' }, { destination: 'server-name' }]) {
    const c = config(); Object.assign(c.rules[0], patch);
    assert.ok(validateFirewall(c).length);
  }
});
test('filtering needs an enabled interface; routing-only can start unconfigured', () => {
  assert.ok(validateFirewall({ firewallEnabled: true, interfaces: [], rules: [] }).length);
  assert.deepEqual(validateFirewall({ firewallEnabled: false, interfaces: [], rules: [] }), []);
});
test('IPv4 parser supports hosts and CIDR including /0', () => {
  assert.equal(ipv4Network('0.0.0.0/0').network, 0);
  assert.equal(ipv4Network('10.10.10.10').prefix, 32);
  assert.equal(ipv4Network('1.2.3.4/33'), null);
  assert.equal(ipv4Network('1.2.3.4/-1'), null);
  assert.equal(ipv4Network('1.2.3.4/2e1'), null);
  assert.equal(ipv4Network('01.2.3.4/24'), null);
});
test('firewall settings survive backup and active invalid configurations are rejected', () => {
  const fw = { id: 'fw', name: 'Firewall', type: 'firewall', x: 0, y: 0, ip: '10.10.10.1/24', ...config() };
  const hosts = ['pc', 'server'].map(id => ({ id, name: id, type: 'pc', x: 0, y: 0, ip: '' }));
  const links = hosts.map(h => ({ from: h.id, to: 'fw' }));
  const restored = parseLab(serializeLab([fw, ...hosts], links, DEFAULT_VIEW));
  assert.deepEqual(restored.devices[0].rules, fw.rules);
  const file = JSON.parse(serializeLab([fw, ...hosts], links, DEFAULT_VIEW));
  file.devices[0].rules[0].interfaceId = 'missing';
  assert.throws(() => parseLab(JSON.stringify(file)), /Invalid firewall/);
});
