const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const firewallConfigModule = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(`${__dirname}/../src/firewallConfig.mjs`, 'utf8'), {
  loader: 'js', format: 'cjs',
}).code, { module: firewallConfigModule, exports: firewallConfigModule.exports });
const deviceProfileModule = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(`${__dirname}/../src/deviceProfile.mjs`, 'utf8'), {
  loader: 'js', format: 'cjs',
}).code, { module: deviceProfileModule, exports: deviceProfileModule.exports, require: () => firewallConfigModule.exports });
const labFileModule = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(`${__dirname}/../src/labFile.mjs`, 'utf8'), {
  loader: 'js', format: 'cjs',
}).code, { module: labFileModule, exports: labFileModule.exports, TextEncoder, require: name => name === "./deviceProfile.mjs" ? deviceProfileModule.exports : firewallConfigModule.exports });

// Exercise App's actual traffic callback with deterministic React state and timers.
const code = transformSync(fs.readFileSync(`${__dirname}/../src/App.jsx`, 'utf8'), {
  loader: 'jsx', format: 'cjs',
}).code;
function trafficHarness(connections = [{ from: 'pc', to: 'switch', conditions: { lossPct: 100 } }]) {
  const devices = [{ id: 'pc', name: 'PC', ip: '10.0.0.1' },
    { id: 'switch', name: 'Switch', ip: '' }, { id: 'server', name: 'Server', ip: '10.0.0.2' }];
  const state = [];
  let index = 0;
  let callback;
  let removeConnection;
  let addConnection;
  let removeDevice;
  const react = {
    useState(initial) {
      const slot = index++;
      state[slot] = slot === 0 ? devices : slot === 1 ? connections : initial;
      return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value; }];
    },
    useCallback: fn => fn, useEffect() {}, useRef: value => ({ current: value }),
    createElement(type, props) {
      if (props?.onTrafficGenerated) callback = props.onTrafficGenerated;
      if (props?.onRemoveConnection) removeConnection = props.onRemoveConnection;
      if (props?.onAddConnection) addConnection = props.onAddConnection;
      if (props?.onRemoveDevice) removeDevice = props.onRemoveDevice;
      return null;
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: name => name === 'react' ? react : name === './labFile.mjs' ? labFileModule.exports : name === './deviceProfile.mjs' ? deviceProfileModule.exports : () => null,
    setTimeout: () => 1, Date, Math,
  });
  module.exports.default();
  return { apply: callback, state, removeConnection, addConnection, removeDevice };
}
const frame = { src: '10.0.0.1', dst: '10.0.0.2', protocol: 'ICMP', info: 'echo request',
  fromDeviceId: 'pc', toDeviceId: 'switch', simulationApplied: true, status: 'delivered', time: 1.25 };

test('multi-hop packets use the physical hop and preserve backend delivery', () => {
  const { apply, state } = trafficHarness();
  const result = apply([frame]);
  assert.equal(result.deliveredPackets.length, 1);
  assert.equal(result.droppedPackets.length, 0);
  assert.equal(result.deliveredPackets[0].time, 1.25);
  assert.equal(state[4].pc.outbound, 1);
  assert.equal(state[4].switch.inbound, 1);
  assert.equal(state[4].server, undefined);
  assert.equal(state[7][0].toId, 'switch');
});

test('backend drops stay dropped without incrementing delivery counters or animating', () => {
  const { apply, state } = trafficHarness();
  const result = apply([{ ...frame, status: 'dropped', dropReason: 'blocked', info: 'DROP (blocked) echo request' }]);
  assert.equal(result.deliveredPackets.length, 0);
  assert.equal(result.droppedPackets.length, 1);
  assert.equal(state[4].pc, undefined);
  assert.equal(state[6]['pc->switch'].dropped, 1);
  assert.equal(state[6]['pc->switch'].blocked, 1);
  assert.equal(state[7].length, 0);
});

test('route and switch diagnostics do not require endpoint cables or count as traffic', () => {
  const { apply, state } = trafficHarness();
  const result = apply([{ ...frame, protocol: 'ROUTE' }, { ...frame, protocol: 'L2' }]);
  assert.equal(result.deliveredPackets.length, 2);
  assert.equal(result.droppedPackets.length, 0);
  assert.equal(state[4].pc, undefined);
  assert.equal(state[7].length, 0);
});

test('ARP broadcasts use physical hop IDs for counters and animation', () => {
  const { apply, state } = trafficHarness();
  const result = apply([{ ...frame, protocol: 'ARP', dst: 'ff:ff:ff:ff:ff:ff' }]);
  assert.equal(result.deliveredPackets.length, 1);
  assert.equal(state[5].switch.inbound, 1);
  assert.equal(state[7][0].toId, 'switch');
});

test('locally generated traffic still applies link conditions', () => {
  const { apply } = trafficHarness();
  const result = apply([{ ...frame, simulationApplied: false }]);
  assert.equal(result.deliveredPackets.length, 0);
  assert.equal(result.droppedPackets.length, 1);
  assert.match(result.droppedPackets[0].info, /loss 100%/);
});


test('disconnect removes only the selected link, its counters, flights, and switch port entries', () => {
  const { apply, state, removeConnection } = trafficHarness([
    { from: 'pc', to: 'switch' }, { from: 'switch', to: 'server' },
  ]);
  state[0][1].mac_table = { 'mac-pc': 'link-switch-pc', 'mac-server': 'link-switch-server' };
  apply([frame, { ...frame, fromDeviceId: 'switch', toDeviceId: 'server' }]);
  removeConnection('switch', 'pc');
  assert.equal(state[1].length, 1);
  assert.equal(state[1][0].to, 'server');
  assert.equal(state[6]['pc->switch'], undefined);
  assert.equal(state[6]['switch->server'].forward, 1);
  assert.equal(state[7].length, 1);
  assert.equal(state[7][0].linkKey, 'switch->server');
  assert.equal(state[0].length, 3);
  assert.equal(state[0][1].mac_table['mac-pc'], undefined);
  assert.equal(state[0][1].mac_table['mac-server'], 'link-switch-server');
});

test('a disconnected device can connect to a different device with fresh link settings', () => {
  const { state, removeConnection, addConnection } = trafficHarness();
  removeConnection('pc', 'switch');
  assert.equal(state[1].length, 0);
  addConnection('pc', 'server', 'both', 'cat');
  assert.equal(state[1].length, 1);
  assert.equal(state[1][0].from, 'pc');
  assert.equal(state[1][0].to, 'server');
  assert.equal(state[1][0].conditions.lossPct, 0);
});


test('removing a device deletes its cables and traffic state while preserving other devices and links', () => {
  const { apply, state, removeDevice } = trafficHarness([
    { from: 'pc', to: 'switch' }, { from: 'switch', to: 'server' },
  ]);
  state[0][1].mac_table = { 'mac-pc': 'link-switch-pc', 'mac-server': 'link-switch-server' };
  apply([frame, { ...frame, fromDeviceId: 'switch', toDeviceId: 'server' }]);
  removeDevice('pc');
  assert.equal(state[0].length, 2);
  assert.equal(state[0].some(device => device.id === 'pc'), false);
  assert.equal(state[1].length, 1);
  assert.equal(state[1][0].to, 'server');
  assert.equal(state[4].pc, undefined);
  assert.equal(state[5].pc, undefined);
  assert.equal(state[6]['pc->switch'], undefined);
  assert.equal(state[6]['switch->server'].forward, 1);
  assert.equal(state[7].length, 1);
  assert.equal(state[7][0].linkKey, 'switch->server');
  assert.equal(state[0][0].mac_table['mac-pc'], undefined);
  assert.equal(state[0][0].mac_table['mac-server'], 'link-switch-server');
});

test('disconnecting the last firewall interface disables it and filtering without losing rules', () => {
  const { state, removeConnection } = trafficHarness();
  state[0][0].type = 'firewall';
  state[0][0].firewallEnabled = true;
  state[0][0].interfaces = [{ id: 'lan', name: 'LAN', address: '10.0.0.1/24', neighborId: 'switch', enabled: true }];
  state[0][0].rules = [{ id: 'pass-lan', interfaceId: 'lan' }];
  removeConnection('pc', 'switch');
  assert.equal(state[0][0].interfaces[0].enabled, false);
  assert.equal(state[0][0].interfaces[0].neighborId, '');
  assert.equal(state[0][0].firewallEnabled, false);
  assert.equal(state[0][0].rules.length, 1);
});
