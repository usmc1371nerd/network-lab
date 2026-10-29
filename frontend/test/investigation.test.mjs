import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { explainService, investigationTarget, summarizeResponse } from '../src/investigation.mjs';
const asset = { name: 'Laptop', ip: '192.168.7.90', discovery: { observations: [] } };
const saved = { ...asset, discovery: { observations: [{ ip: '10.0.0.20', observedAt: '2026-10-28T12:00:00Z', mac: '02:00:00:00:00:20' }] } };
const networks = [{ id: 'lan', interface: 'eth0', connectedCidr: '10.0.0.0/24' }];
const parseXml = text => new DOMParser().parseFromString(text, 'application/xml');
const result = (hosts = '') => ({ xml: `<nmaprun>${hosts}</nmaprun>`, network: { cidr: '10.0.0.20/32', interface: 'eth0' } });
const host = (ip, mac = '') => `<host><status state="up"/><address addr="${ip}" addrtype="ipv4"/>${mac ? `<address addr="${mac}" addrtype="mac"/>` : ''}</host>`;

test('live target uses latest observed IP rather than configured lab override', () => {
  const target = investigationTarget(saved, networks);
  assert.equal(target.cidr, '10.0.0.20/32');
  assert.deepEqual(target.networks, networks);
  assert.equal(investigationTarget(asset, networks).cidr, '');
  const newer = { ...saved, discovery: { observations: [...saved.discovery.observations, { ip: '10.0.0.21', observedAt: '2026-10-29T12:00:00Z' }] } };
  assert.equal(investigationTarget(newer, networks).cidr, '10.0.0.21/32');
});
test('only usable host addresses on directly connected private subnets are eligible', () => {
  for (const ip of ['8.8.8.8', '10.1.0.1', '10.0.0.0', '10.0.0.255', '10.0.0.20/24', 'hostname']) {
    assert.equal(investigationTarget({ discovery: { observations: [{ ip }] } }, networks).networks.length, 0, ip);
  }
  assert.equal(investigationTarget(saved, [{ ...networks[0], connectedCidr: '10.0.0.20/31' }]).networks.length, 1);
});
test('service explanations preserve ambiguity and distinguish port labels from software detection', () => {
  const table = explainService({ port: 22, name: 'ssh', state: 'open', method: 'table' });
  assert.match(table.purpose, /Remote terminal/);
  assert.match(table.evidence, /does not confirm/);
  assert.match(explainService({ port: 443, state: 'open|filtered', method: 'probed' }).state, /could not distinguish/);
  assert.match(explainService({ port: 443, state: 'open' }).purpose, /commonly associated/);
  assert.match(explainService({ port: 65000, state: 'filtered' }).state, /could not determine/);
  assert.match(explainService({ port: 65000, state: 'closed' }).purpose, /not known/);
});
test('response summaries do not turn silence into offline status or responses into identity proof', () => {
  assert.match(summarizeResponse(saved, result(), parseXml), /does not prove it is offline/);
  assert.match(summarizeResponse(saved, result(host('10.0.0.20')), parseXml), /does not verify device identity/);
  assert.match(summarizeResponse(saved, result(host('10.0.0.21')), parseXml), /No response/);
  assert.match(summarizeResponse(saved, result(host('10.0.0.20', '02:00:00:00:00:21')), parseXml), /MAC differs/);
  const cached = { ...result(host('10.0.0.20')), neighbors: [{ ip: '10.0.0.20', mac: '02:00:00:00:00:21' }] };
  assert.match(summarizeResponse(saved, cached, parseXml), /Review device identity/);
});
