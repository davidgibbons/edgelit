// The graph must match what HA's power sankey draws for the same input.
import assert from 'node:assert/strict';

globalThis.HTMLElement = class {};
const registry = {};
globalThis.customElements = { get: (n) => registry[n], define: (n, c) => { registry[n] = c; } };
globalThis.window = {};

const card = await import('../dist/edgelit-energy-card.js');
const st = (v, unit = 'W') => ({ state: String(v), attributes: { unit_of_measurement: unit } });

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

const dev = (name, id, parent) => ({ name, stat_consumption: `${id}_kwh`, stat_rate: `sensor.${id}`, ...(parent ? { included_in_stat: `${parent}_kwh` } : {}) });
const prefs = {
  energy_sources: [
    { type: 'grid', stat_energy_from: 'g_kwh', stat_rate: 'sensor.grid' },
    { type: 'battery', stat_energy_from: 'o', stat_energy_to: 'i', stat_rate: 'sensor.bat' },
  ],
  device_consumption: [
    dev('A/C', 'ac'), dev('Hot tub', 'tub'), dev('Office', 'office'), dev('Lamp', 'lamp'), dev('Fan', 'fan'), dev('Clock', 'clock'),
    { name: 'No power', stat_consumption: 'np_kwh' },
    dev('PC', 'pc', 'office'), dev('Server', 'srv', 'office'), dev('Charger', 'chg', 'office'),
  ],
};
const hass = {
  states: {
    'sensor.grid': st(10000), 'sensor.bat': st(-4000),
    'sensor.ac': st(2.0, 'kW'), 'sensor.tub': st(2000), 'sensor.office': st(900),
    'sensor.lamp': st(3), 'sensor.fan': st(2), 'sensor.clock': st('unavailable'),
    'sensor.pc': st(500), 'sensor.srv': st(150), 'sensor.chg': st(4),
  },
  entities: { 'sensor.ac': { device_id: 'd1' }, 'sensor.tub': { area_id: 'garage' } },
  devices: { d1: { area_id: 'garage' } },
  areas: { garage: { area_id: 'garage', name: 'Garage' } },
  floors: {},
};
const node = (g, id) => g.nodes.find((n) => n.id === id);
const link = (g, s, t) => g.links.find((l) => l.source === s && l.target === t);

// Sources: grid feeds the house and the charging battery, as HA routes it.
const g = card.buildGraph(prefs, hass);
assert.equal(g.used, 6000);
assert.equal(link(g, 'grid', 'home').value, 6000);
assert.equal(link(g, 'grid', 'battery_in').value, 4000);
assert.equal(node(g, 'battery_in').col, 1);

// Area grouping: A/C via its device's area, the hot tub via its own.
assert.equal(node(g, 'area_garage').value, 4000);
assert.equal(link(g, 'area_garage', 'sensor.ac').value, 2000);
assert.equal(link(g, 'area_garage', 'sensor.tub').value, 2000);
assert.ok(link(g, 'home', 'sensor.office'), 'devices with no area hang off home');

// Threshold is 0.1% of the house (6 W): Lamp and Fan fold into one "Other";
// a lone small child (Charger, 4 W) still shows by name.
assert.equal(node(g, 'other_home').value, 5);
assert.ok(!node(g, 'sensor.lamp') && !node(g, 'sensor.clock'));
assert.ok(link(g, 'sensor.office', 'sensor.chg'), 'lone small device keeps its name');
assert.ok(!node(g, 'np_kwh'), 'devices without a power sensor are left out');

assert.equal(node(g, 'untracked_sensor.office').value, 246);
assert.equal(node(g, 'untracked').value, 6000 - 2000 - 2000 - 900 - 5);

// Columns: sources, home, areas, circuits, devices; empty floor column dropped.
assert.deepEqual(['grid', 'home', 'area_garage', 'sensor.office', 'sensor.pc'].map((id) => node(g, id).col), [0, 1, 2, 3, 4]);

const flat = card.buildGraph(prefs, hass, { groupByArea: false, groupByFloor: false });
assert.ok(link(flat, 'home', 'sensor.ac') && !node(flat, 'area_garage'));

// The cap folds the smallest named children into "Other", subtree and all:
// with 2 allowed at the top, Office (and its devices) and A/C fold.
const capped = card.buildGraph(prefs, hass, { groupByArea: false, maxDevices: 2 });
assert.ok(node(capped, 'sensor.tub') && !node(capped, 'sensor.office') && !node(capped, 'sensor.pc'));
assert.equal(node(capped, 'other_home').value, 2905);

const dis = card.buildGraph(prefs, { ...hass, states: { ...hass.states, 'sensor.grid': st(1000), 'sensor.bat': st(5000) } });
assert.equal(link(dis, 'battery', 'home').value, 5000);
assert.equal(link(dis, 'grid', 'home').value, 1000);

const half = card.easeGraph({ nodes: [], links: [], used: 0 }, g, 0.5);
assert.equal(half.used, 3000);
assert.equal(node(half, 'area_garage').value, 2000);

const geo = card.layout(g, 2560, 600);
for (const n of geo.nodes) assert.ok(n.top >= 0 && n.top + n.h <= 600, `${n.label} fits`);
const s = geo.streams.find((x) => x.key === 'home>sensor.office');
const end = card.pointAt(s, 1, 1);
assert.ok(Math.abs(end[0] - geo.nodes.find((n) => n.id === 'sensor.office').x) < 1e-9);

// Totals: house kWh is grid in plus battery out minus battery in; cost is the
// grid's, from the cost sensor HA created when the source has no stat_cost.
const tp = { energy_sources: [
  { type: 'grid', stat_energy_from: 'imp', stat_energy_to: null, stat_cost: null },
  { type: 'battery', stat_energy_from: 'dis', stat_energy_to: 'chg' },
] };
const now = Date.parse('2026-10-02T12:00:00Z');
const at = (h, change) => ({ start: now - h * 3600000, change });
const stats = { imp: [at(20, 10), at(2, 3)], dis: [at(5, 4)], chg: [at(23, 6)], 'sensor.imp_cost': [at(20, 1.5), at(2, 0.5)] };
const costs = { imp: 'sensor.imp_cost' };
assert.deepEqual(card.totalIds(tp, costs), ['imp', 'sensor.imp_cost', 'dis', 'chg']);
assert.deepEqual(card.totals(tp, costs, stats, 24, now), { kwh: 11, cost: 2 });
assert.deepEqual(card.totals(tp, costs, stats, 8, now), { kwh: 7, cost: 0.5 });

assert.ok(registry['edgelit-energy-card'], 'card registers');
console.log('ok');
