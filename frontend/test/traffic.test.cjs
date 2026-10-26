const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

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
  const react = {
    useState(initial) {
      const slot = index++;
      state[slot] = slot === 0 ? devices : slot === 1 ? connections : initial;
      return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value; }];
    },
    useCallback: fn => fn, useEffect() {}, useRef: value => ({ current: value }),
    createElement(type, props) { if (props?.onTrafficGenerated) callback = props.onTrafficGenerated; return null; },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: name => name === 'react' ? react : () => null,
    setTimeout: () => 1, Date, Math,
  });
  module.exports.default();
  return { apply: callback, state };
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
