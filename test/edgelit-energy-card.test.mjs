// Drives the pure helpers of edgelit-energy-card against a canned
// `energy/get_prefs` payload and canned states.
import assert from 'node:assert/strict';

globalThis.HTMLElement = class {};
const registry = {};
globalThis.customElements = { get: (n) => registry[n], define: (n, c) => { registry[n] = c; } };
globalThis.window = {};

const card = await import('../dist/edgelit-energy-card.js');
const st = (v, unit = 'W') => ({ state: String(v), attributes: { unit_of_measurement: unit } });

// Units and formulas
assert.equal(card.watts(st(1.5, 'kW')), 1500);
assert.equal(card.watts(st(42)), 42);
assert.equal(card.watts(st('unavailable')), null);
assert.equal(card.watts(undefined), null);
assert.equal(card.crossSeconds(2400), 2.5);
assert.ok(Math.abs(card.crossSeconds(130) - 6.97) < 0.05, 'about 7 s at 130 W');
assert.equal(card.particleCount(10), 2);
assert.equal(card.particleCount(2500), 10);
assert.equal(card.fmtW(2400), '2.4 kW');
assert.equal(card.fmtW(130.4), '130 W');
assert.equal(card.shade('#000000', 0), '#2e2e2e');

const prefs = {
  energy_sources: [
    { type: 'grid', stat_energy_from: 'sensor.grid_kwh', stat_rate: 'sensor.grid' },
    { type: 'battery', stat_energy_from: 'sensor.out', stat_energy_to: 'sensor.in', stat_rate: 'sensor.bat' },
  ],
  device_consumption: [
    { name: 'A/C', stat_consumption: 'sensor.ac_kwh', stat_rate: 'sensor.ac' },
    { name: 'Office', stat_consumption: 'sensor.office_kwh', stat_rate: 'sensor.office' },
    { name: 'Lamp', stat_consumption: 'sensor.lamp_kwh', stat_rate: 'sensor.lamp' },
    { name: 'No power', stat_consumption: 'sensor.np_kwh' },
    { name: 'PC', stat_consumption: 'sensor.pc_kwh', stat_rate: 'sensor.pc', included_in_stat: 'sensor.office_kwh' },
    { name: 'Server', stat_consumption: 'sensor.srv_kwh', stat_rate: 'sensor.srv', included_in_stat: 'sensor.office_kwh' },
    { name: 'Charger', stat_consumption: 'sensor.chg_kwh', stat_rate: 'sensor.chg', included_in_stat: 'sensor.office_kwh' },
  ],
};
const states = {
  'sensor.grid': st(3000), 'sensor.bat': st(0.5, 'kW'),
  'sensor.ac': st(2.0, 'kW'), 'sensor.office': st(900), 'sensor.lamp': st(40),
  'sensor.pc': st(500), 'sensor.srv': st(150), 'sensor.chg': st(30),
};

// Tree from included_in_stat; remainders; folding below min_watts
const t = card.buildTree(prefs, states, { minWatts: 100 });
assert.deepEqual(t.sources.map((s) => [s.name, s.w]), [['Grid', 3000], ['Battery', 500]]);
assert.equal(t.total, 3500, 'total is the sum of sources');
assert.deepEqual(t.nodes.map((n) => [n.name, n.w]), [['A/C', 2000], ['Office', 900], ['Other', 40], ['Untracked', 560]]);
const office = t.nodes[1];
assert.deepEqual(office.children.map((c) => [c.name, c.w]), [['PC', 500], ['Server', 150], ['Untracked', 250]],
  'children sorted by power, Charger folded into the circuit remainder');
assert.ok(office.children.every((c) => c.color), 'children take a shade of the circuit');
assert.equal(t.nodes[0].color, '#38bdf8', 'tier-1 color follows Energy-settings order');

// Untracked clamps at zero when meters skew; a charging battery is a load.
const skew = card.buildTree(prefs, { ...states, 'sensor.grid': st(2500), 'sensor.bat': st(-400) }, { minWatts: 100 });
assert.equal(skew.total, 2500);
assert.equal(skew.charging, 400);
assert.ok(!skew.nodes.some((n) => n.name === 'Untracked'), 'negative remainder draws nothing');
assert.ok(skew.nodes.some((n) => n.key === 'charging' && n.w === 400));

// A home entity sets the total; an unavailable circuit counts as 0 W, dimmed.
const home = card.buildTree(prefs, { ...states, 'sensor.home': st(3200), 'sensor.ac': st('unavailable') }, { home: 'sensor.home', minWatts: 100 });
assert.equal(home.total, 3200);
assert.ok(home.nodes.find((n) => n.name === 'Other').w === 40, 'dead A/C folds as 0 W');

// Easing moves widths part way and grows new nodes from zero.
const half = card.easeTree(skew, t, 0.5);
assert.equal(half.total, 3000);
assert.equal(half.nodes.find((n) => n.key === 'untracked').w, 280);

// Layout stays inside the box and particles ride the stream.
const g = card.layout(t, 2560, 600);
for (const n of [...g.nodes, ...g.kids]) assert.ok(n.top >= 0 && n.top + n.h <= 600, `${n.name} fits`);
const s = g.streams[0];
assert.deepEqual(card.pointAt(s, 0, 0), [g.x0, s.a[0]]);
const end = card.pointAt(s, 1, 1);
assert.ok(Math.abs(end[0] - g.x2) < 1e-9 && Math.abs(end[1] - s.b[1]) < 1e-9);

assert.ok(registry['edgelit-energy-card'], 'card registers');
console.log('ok');
