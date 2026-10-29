import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { parseNmapXml, suggestInventoryMatch, applyNmapReview, practiceCopies, MAX_NMAP_BYTES } from '../src/nmapImport.mjs';
import { serializeLab, parseLab, DEFAULT_VIEW } from '../src/labFile.mjs';
const parseXml = text => new DOMParser({ onError: (level, message) => { throw new Error(message); } }).parseFromString(text, 'application/xml');
const sample = readFileSync(new URL('../src/examples/nmap-sample.xml', import.meta.url), 'utf8');
const parse = text => parseNmapXml(text, { parseXml, sourceFile: 'scan.xml', fallbackTime: '2026-10-28T12:00:00Z' });
const selected = candidate => ({ key: candidate.key, selected: true, targetId: 'new' });
const create = () => { let id = 0; const scan = parse(sample); return applyNmapReview([], scan.candidates, scan.candidates.map(selected), () => `test-${++id}`).inventory; };

test('standard Nmap XML parses reported identity, port details, and cautious type suggestions', () => {
  const scan = parse(sample);
  assert.equal(scan.candidates.length, 3);
  assert.equal(scan.skipped.notUp, 1);
  const router = scan.candidates[0].observation;
  assert.equal(router.ip, '10.0.0.1');
  assert.equal(router.mac, '02:00:00:00:00:01');
  assert.equal(router.hostname, 'home-router.local');
  assert.equal(router.vendor, 'Example Network Equipment');
  assert.equal(router.suggestedType, 'router');
  assert.equal(router.confidence, .95);
  assert.equal(router.timestampSource, 'host-end');
  assert.equal(router.services[0].port, 443);
  assert.equal(scan.candidates[1].observation.suggestedType, 'unknown');
  assert.equal(scan.candidates[1].observation.confidence, undefined);
  assert.equal(scan.candidates[1].observation.services[1].state, 'closed');
  assert.equal(scan.candidates[1].observation.services[1].method, 'table');
});

test('new inventory assets remain unknown and contain no invented simulation address or links', () => {
  const assets = create();
  assert.equal(assets.length, 3);
  assert.ok(assets.every(a => a.type === 'unknown' && a.ip === '' && a.id.startsWith('asset-')));
  assert.equal(assets[0].discovery.observations[0].suggestedType, 'router');
  assert.equal(assets[0].connections, undefined);
});

test('malformed, unrelated, failed scans, external DTDs, and entities are rejected', () => {
  for (const text of ['<nmaprun>', '<html/>', '<nmaprun scanner="masscan"/>', '<!DOCTYPE nmaprun SYSTEM "https://example.org/test.dtd"><nmaprun/>', '<!DOCTYPE nmaprun [<!ENTITY x "test">]><nmaprun/>', '<nmaprun><runstats><finished exit="error"/></runstats></nmaprun>']) assert.throws(() => parse(text));
});

test('only hosts reported up with supported IPv4 enter review, with duplicate addresses counted', () => {
  const xml = '<nmaprun><host><status state="up"/><address addr="2001:db8::1" addrtype="ipv6"/></host><host><status state="up"/><address addr="10.0.0.2" addrtype="ipv4"/></host><host><status state="up"/><address addr="10.0.0.2" addrtype="ipv4"/></host><hosthint><status state="up"/><address addr="10.0.0.3" addrtype="ipv4"/></hosthint></nmaprun>';
  const scan = parse(xml);
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.skipped.unsupported, 1);
  assert.equal(scan.skipped.duplicate, 1);
  assert.equal(scan.candidates[0].observation.timestampSource, 'import-time');
});

test('file and host limits are enforced', () => {
  assert.throws(() => parse(' '.repeat(MAX_NMAP_BYTES + 1)), /5 MB/);
  assert.throws(() => parse(`<nmaprun>${'<host/>'.repeat(1001)}</nmaprun>`), /1,000/);
});

test('MAC match suggests a reviewed update and preserves user corrections on rescan', () => {
  const assets = create();
  assets[0] = { ...assets[0], name: 'My Router', type: 'router', ip: '192.168.1.1', profile: { notes: 'Hall cupboard', overrides: { name: true, type: true, ip: true } } };
  const candidate = parse(sample).candidates[0];
  candidate.observation = { ...candidate.observation, observedAt: '2026-10-29T12:00:00Z', ip: '10.0.0.254', hostname: 'new-hostname' };
  const suggestion = suggestInventoryMatch(candidate, assets);
  assert.equal(suggestion.targetId, assets[0].id);
  const result = applyNmapReview(assets, [candidate], [{ key: candidate.key, ...suggestion }]);
  assert.equal(result.updated, 1);
  assert.equal(result.added, 0);
  assert.equal(result.inventory[0].name, 'My Router');
  assert.equal(result.inventory[0].ip, '192.168.1.1');
  assert.equal(result.inventory[0].type, 'router');
  assert.equal(result.inventory[0].profile.notes, 'Hall cupboard');
  assert.equal(result.inventory[0].discovery.observations.at(-1).ip, '10.0.0.254');
  assert.equal(assets[0].discovery.observations.length, 1);
});

test('IP-only matches, changed MACs, and shared identities require explicit review', () => {
  const assets = create(), candidate = parse(sample).candidates[0];
  assert.equal(suggestInventoryMatch({ ...candidate, observation: { ...candidate.observation, mac: '' } }, assets).selected, false);
  assert.equal(suggestInventoryMatch({ ...candidate, observation: { ...candidate.observation, mac: '02:11:22:33:44:55' } }, assets).selected, false);
  assert.equal(suggestInventoryMatch({ ...candidate, sharedMac: true }, assets).selected, false);
});

test('repeat scans deduplicate observations; skipped rows and absent hosts leave inventory intact', () => {
  const assets = create(), candidate = parse(sample).candidates[0];
  const result = applyNmapReview(assets, [candidate], [{ key: candidate.key, selected: true, targetId: assets[0].id }]);
  assert.equal(result.inventory[0].discovery.observations.length, 1);
  assert.equal(result.inventory.length, 3);
  assert.deepEqual(applyNmapReview(assets, [candidate], [{ ...selected(candidate), selected: false }]).inventory, assets);
});

test('invalid review destinations fail atomically', () => {
  const assets = create(), scan = parse(sample), before = JSON.stringify(assets);
  assert.throws(() => applyNmapReview(assets, scan.candidates, [{ key: scan.candidates[0].key, selected: true, targetId: assets[0].id }, { key: scan.candidates[1].key, selected: true, targetId: 'gone' }]));
  assert.equal(JSON.stringify(assets), before);
});

test('practice copies have independent IDs and configured IPs without changing inventory', () => {
  const assets = create();
  assets[0].type = 'router';
  const copy = practiceCopies([assets[0]], [], () => 'copy')[0];
  assert.equal(copy.id, 'lab-copy');
  assert.equal(copy.practiceSourceId, assets[0].id);
  assert.equal(copy.ip, '10.0.0.1/24');
  assert.equal(copy.type, 'router');
  assert.deepEqual(copy.routes, []);
  assert.equal(copy.mac, '');
  assert.equal(copy.connections, undefined);
  assert.equal(assets[0].ip, '');
  const withOverride = { ...assets[0], ip: '192.168.50.1/24' };
  assert.equal(practiceCopies([withOverride], [], () => 'copy')[0].ip, '192.168.50.1/24');
  assert.throws(() => practiceCopies([assets[0]], [{ id: 'existing', name: 'Existing', ip: '10.0.0.1/24' }]), /already contains/);
});

test('JSON backup restores inventory and profile history, preserves lab references, and supports older files', () => {
  const inventory = create();
  const lab = [{ id: 'pc', name: 'Lab PC', type: 'pc', ip: '192.168.1.2', x: 0, y: 0 }];
  const result = parseLab(serializeLab(lab, [], DEFAULT_VIEW, inventory));
  assert.deepEqual(result.inventory, inventory);
  assert.equal(result.devices[0].id, 'pc');
  assert.deepEqual(parseLab(JSON.stringify({ format: 'network-lab', version: 1, devices: [], connections: [] })).inventory, []);
  const invalid = JSON.parse(serializeLab(lab, [], DEFAULT_VIEW, inventory)); invalid.inventory[0].discovery.observations[0].services[0].port = '443';
  assert.throws(() => parseLab(JSON.stringify(invalid)), /service/);
});
