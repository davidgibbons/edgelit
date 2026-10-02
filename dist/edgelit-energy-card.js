// Live power flow. buildGraph ports Home Assistant's power sankey
// (home-assistant/frontend: cards/energy/hui-power-sankey-card.ts and
// common/sankey.ts) so both cards show the same devices.

const FONT = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap';
const DEAD = ['unavailable', 'unknown'];
const PALETTE = ['#38bdf8', '#a78bfa', '#34d399', '#f472b6', '#fb923c', '#fbbf24', '#f87171', '#2dd4bf',
  '#818cf8', '#a3e635', '#e879f9', '#60a5fa', '#facc15', '#c084fc', '#5eead4', '#fda4af', '#93c5fd'];
const COLOR = { grid: '#60a5fa', battery: '#34d399', battery_in: '#4ade80', grid_return: '#a78bfa', home: '#e2e8f0', other: '#94a3b8', untracked: '#64748b' };
// HA's values.
const MIN_FACTOR = 0.001;
const MAX_DEVICES = 20;
const MAX_PARTICLES = 150;
const FRAME_MS = 1000 / 30;
const UPDATE_MS = 5000;
const EASE_MS = 1000;
const PREFS_MS = 5 * 60000;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const watts = (s) => {
  if (!s || DEAD.includes(s.state)) return null;
  const v = parseFloat(s.state);
  if (Number.isNaN(v)) return null;
  return /^kW$/i.test(s.attributes?.unit_of_measurement || '') ? v * 1000 : v;
};

export const fmtW = (w) => (w >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`);

export const crossSeconds = (w) => 2.5 * (2400 / Math.max(w, 1)) ** 0.35;
export const particleCount = (w) => Math.max(2, Math.round(Math.sqrt(w) / 5));

// Columns: sources, home, floors, areas, then one per level of device nesting.
export function buildGraph(prefs, hass, { groupByArea = true, groupByFloor = true, maxDevices = MAX_DEVICES, colors = {} } = {}) {
  const states = hass.states;
  const power = (id) => watts(states[id]) ?? 0;
  const nodes = [];
  const links = [];

  // HA's source routing, minus solar.
  let fromGrid = 0;
  let toGrid = 0;
  let net = 0;
  for (const s of prefs?.energy_sources || []) {
    if (!s.stat_rate) continue;
    const v = power(s.stat_rate);
    if (s.type === 'grid') { if (v > 0) fromGrid += v; else toGrid -= v; }
    if (s.type === 'battery') net += v;
  }
  const fromBat = Math.max(net, 0);
  const toBat = Math.max(-net, 0);
  const used = Math.max(fromGrid + fromBat - toGrid - toBat, 0);
  let gridLeft = fromGrid;
  let batLeft = fromBat;
  let usedLeft = used;
  const excess = Math.max(0, Math.min(toBat, gridLeft - usedLeft));
  let gridToBat = excess;
  gridLeft -= excess;
  const batToGrid = Math.min(batLeft, toGrid);
  batLeft -= batToGrid;
  const more = Math.min(gridLeft, toBat - excess);
  gridToBat += more;
  gridLeft -= more;
  const usedBat = Math.min(batLeft, usedLeft);
  usedLeft -= usedBat;
  const usedGrid = Math.min(usedLeft, gridLeft);

  const sourceId = (type) => prefs.energy_sources.find((s) => s.type === type && s.stat_rate)?.stat_rate;
  const add = (n) => { nodes.push({ color: COLOR[n.id], ...n }); };
  if (fromGrid > 0) { add({ id: 'grid', label: 'Grid', value: fromGrid, col: 0, entityId: sourceId('grid') }); links.push({ source: 'grid', target: 'home', value: usedGrid }); }
  if (fromBat > 0) { add({ id: 'battery', label: 'Battery', value: fromBat, col: 0, entityId: sourceId('battery') }); links.push({ source: 'battery', target: 'home', value: usedBat }); }
  add({ id: 'home', label: 'Home', value: used, col: 1 });
  if (toBat > 0) { add({ id: 'battery_in', label: 'Battery', value: toBat, col: 1, entityId: sourceId('battery') }); if (gridToBat > 0) links.push({ source: 'grid', target: 'battery_in', value: gridToBat }); }
  if (toGrid > 0) { add({ id: 'grid_return', label: 'Grid', value: toGrid, col: 1, entityId: sourceId('grid') }); if (batToGrid > 0) links.push({ source: 'battery', target: 'grid_return', value: batToGrid }); }

  const devices = prefs?.device_consumption || [];
  const threshold = used * MIN_FACTOR;
  const byStat = new Map(devices.map((d) => [d.stat_consumption, d]));
  const values = new Map();
  const rendered = new Set();
  for (const d of devices) {
    if (!d.stat_rate) continue;
    const v = power(d.stat_rate);
    values.set(d.stat_rate, v);
    if (v >= threshold) rendered.add(d.stat_rate);
  }
  const renderedId = (stat) => {
    const id = byStat.get(stat)?.stat_rate;
    return id && rendered.has(id) ? id : undefined;
  };
  // First rendered ancestor; bounded because included_in_stat can be cyclic.
  const effectiveParent = (stat) => {
    for (let cur = stat, hops = 0; cur && hops < devices.length; hops++) {
      const r = renderedId(cur);
      if (r) return r;
      const d = byStat.get(cur);
      if (!d) return undefined;
      cur = d.included_in_stat;
    }
    return undefined;
  };
  for (const id of overCap(devices, maxDevices, rendered, values, (d) => effectiveParent(d.included_in_stat))) rendered.delete(id);

  const label = (d) => d.name || states[d.stat_rate]?.attributes?.friendly_name || d.stat_rate;
  const colorOf = (d, idx) => colors[label(d)] || PALETTE[idx % PALETTE.length];
  const devNodes = [];
  const parentOf = {};
  const small = new Map();
  const smallStats = new Set();
  let untracked = used;
  const place = (n, parent) => {
    devNodes.push(n);
    if (parent) { parentOf[n.id] = parent; links.push({ source: parent, target: n.id, value: n.value }); } else untracked -= n.value;
  };
  devices.forEach((d, idx) => {
    const id = d.stat_rate;
    if (!id) return;
    const parent = effectiveParent(d.included_in_stat);
    if (!rendered.has(id)) {
      const key = parent ?? 'home';
      if (!small.has(key)) small.set(key, []);
      small.get(key).push({ d, idx, parent });
      smallStats.add(d.stat_consumption);
      return;
    }
    place({ id, label: label(d), value: values.get(id), color: colorOf(d, idx), entityId: id, dead: watts(states[id]) === null }, parent);
  });
  small.forEach((all, key) => {
    // A small device inside another small device is already counted in it.
    const list = all.filter(({ d }) => {
      for (let a = d.included_in_stat, hops = 0; a && hops < devices.length; hops++) {
        if (renderedId(a)) return true;
        if (smallStats.has(a)) return false;
        a = byStat.get(a)?.included_in_stat;
      }
      return true;
    });
    const total = list.reduce((s, { d }) => s + values.get(d.stat_rate), 0);
    if (total <= 0) return;
    if (list.length === 1) {
      const { d, idx, parent } = list[0];
      place({ id: d.stat_rate, label: label(d), value: values.get(d.stat_rate), color: colorOf(d, idx), entityId: d.stat_rate, dead: watts(states[d.stat_rate]) === null }, parent);
    } else {
      place({ id: `other_${key}`, label: 'Other', value: Math.ceil(total), color: colors.Other || COLOR.other }, key === 'home' ? undefined : key);
    }
  });
  for (const pid of new Set(Object.values(parentOf))) {
    const p = devNodes.find((n) => n.id === pid);
    if (!p) continue;
    const rest = p.value - devNodes.reduce((s, n) => (parentOf[n.id] === pid ? s + n.value : s), 0);
    if (rest > 1) place({ id: `untracked_${pid}`, label: 'Untracked', value: rest, color: colors.Untracked || COLOR.untracked }, pid);
  }

  const top = devNodes.filter((n) => !parentOf[n.id]);
  if (groupByArea || groupByFloor) {
    const groups = new Map();
    for (const n of top) {
      const { area, floor } = context(hass, n.id);
      const f = groupByFloor && floor ? floor : null;
      const a = groupByArea && area ? area : null;
      const key = `${f?.floor_id ?? ''}|${a?.area_id ?? ''}`;
      if (!groups.has(key)) groups.set(key, { f, a, devs: [] });
      groups.get(key).devs.push(n);
    }
    const floorSum = new Map();
    for (const g of groups.values()) if (g.f) floorSum.set(g.f.floor_id, (floorSum.get(g.f.floor_id) || 0) + g.devs.reduce((s, n) => s + n.value, 0));
    // A group takes its biggest device's color, so its stream isn't grey.
    const biggest = (devs) => devs.reduce((a, n) => (n.value > a.value ? n : a), devs[0]).color;
    for (const [fid, value] of floorSum) {
      const devs = [...groups.values()].filter((g) => g.f?.floor_id === fid).flatMap((g) => g.devs);
      add({ id: `floor_${fid}`, label: hass.floors[fid]?.name || fid, value, col: 2, color: biggest(devs) });
      links.push({ source: 'home', target: `floor_${fid}`, value });
    }
    for (const g of groups.values()) {
      let parent = g.f ? `floor_${g.f.floor_id}` : 'home';
      if (g.a) {
        const value = g.devs.reduce((s, n) => s + n.value, 0);
        add({ id: `area_${g.a.area_id}`, label: g.a.name || g.a.area_id, value, col: 3, color: biggest(g.devs) });
        links.push({ source: parent, target: `area_${g.a.area_id}`, value });
        parent = `area_${g.a.area_id}`;
      }
      for (const n of g.devs) links.push({ source: parent, target: n.id, value: n.value });
    }
  } else {
    for (const n of top) links.push({ source: 'home', target: n.id, value: n.value });
  }
  const sections = deviceSections(parentOf, devNodes);
  sections.forEach((sec, i) => sec.forEach((n) => nodes.push({ ...n, col: 4 + i })));
  if (untracked > 1) {
    add({ id: 'untracked', label: 'Untracked', value: untracked, col: 3 + sections.length, color: colors.Untracked || COLOR.untracked });
    links.push({ source: 'home', target: 'untracked', value: untracked });
  }

  const cols = [...new Set(nodes.map((n) => n.col))].sort((a, b) => a - b);
  for (const n of nodes) n.col = cols.indexOf(n.col);
  return { nodes, links: links.filter((l) => l.value > 0), used };
}

// HA's findDevicesOverCap.
function overCap(devices, max, rendered, values, parentOf) {
  const grouped = new Set();
  if (!max || max <= 0) return grouped;
  const kids = new Map();
  const seen = new Set();
  devices.forEach((d, idx) => {
    const id = d.stat_rate;
    if (!id || !rendered.has(id) || seen.has(id)) return;
    seen.add(id);
    const key = parentOf(d) ?? 'home';
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push({ id, value: values.get(id), idx });
  });
  const take = (id) => { if (grouped.has(id)) return; grouped.add(id); kids.get(id)?.forEach((c) => take(c.id)); };
  const queue = ['home'];
  const visited = new Set(queue);
  while (queue.length) {
    const children = kids.get(queue.shift());
    if (!children) continue;
    if (children.length > max) {
      [...children].sort((a, b) => a.value - b.value || a.idx - b.idx)
        .slice(0, Math.max(children.length - max, 2)).forEach((c) => take(c.id));
    }
    children.filter((c) => !grouped.has(c.id) && !visited.has(c.id)).forEach((c) => { visited.add(c.id); queue.push(c.id); });
  }
  return grouped;
}

function deviceSections(parentOf, devs) {
  const parents = Object.values(parentOf);
  const head = devs.filter((n) => parents.includes(n.id) && !(n.id in parentOf));
  if (!head.length) return devs.length ? [devs] : [];
  const rest = {};
  for (const [c, p] of Object.entries(parentOf)) if (!head.some((n) => n.id === p)) rest[c] = p;
  return [head, ...deviceSections(rest, devs.filter((n) => !head.includes(n)))];
}

function context(hass, entityId) {
  const ent = hass.entities?.[entityId];
  const areaId = ent?.area_id || hass.devices?.[ent?.device_id]?.area_id;
  const area = areaId ? hass.areas?.[areaId] : null;
  const floor = area?.floor_id ? hass.floors?.[area.floor_id] : null;
  return { area, floor };
}

export function easeGraph(from, to, k) {
  if (!from || k >= 1) return to;
  const nv = new Map(from.nodes.map((n) => [n.id, n.value]));
  const lv = new Map(from.links.map((l) => [`${l.source}>${l.target}`, l.value]));
  const mix = (a = 0, b) => a + (b - a) * k;
  return {
    ...to,
    used: mix(from.used, to.used),
    nodes: to.nodes.map((n) => ({ ...n, value: mix(nv.get(n.id), n.value) })),
    links: to.links.map((l) => ({ ...l, value: mix(lv.get(`${l.source}>${l.target}`), l.value) })),
  };
}

const LAST = (id) => /^(other|untracked)/.test(id);

// Each column is ordered by where its flow leaves the previous one, so
// streams don't cross.
export function layout(graph, W, H) {
  const pad = 30;
  const avail = H - 2 * pad;
  const ncol = Math.max(...graph.nodes.map((n) => n.col), 1) + 1;
  const left = W * 0.09;
  const right = W * 0.82;
  const xs = Array.from({ length: ncol }, (_, i) => left + ((right - left) * i) / (ncol - 1));
  const outSum = (id) => graph.links.reduce((a, l) => (l.source === id ? a + l.value : a), 0);
  const colSum = xs.map((_, c) => graph.nodes.reduce((s, n) => (n.col === c ? s + Math.max(n.value, outSum(n.id)) : s), 0));
  const scale = Math.max(...colSum) > 0 ? (avail * 0.7) / Math.max(...colSum) : 0;
  const byId = new Map(graph.nodes.map((n) => [n.id, { ...n, x: xs[n.col], h: n.value * scale, out: [], in: [] }]));
  const links = graph.links.filter((l) => byId.has(l.source) && byId.has(l.target)).map((l) => ({ ...l, w: l.value * scale }));
  for (const l of links) { byId.get(l.source).out.push(l); byId.get(l.target).in.push(l); }
  // Meter skew can make a node's links outweigh its own value; fit them.
  const sum = (ls) => ls.reduce((a, l) => a + l.w, 0);
  for (const n of byId.values()) n.h = Math.max(n.h, sum(n.in), sum(n.out));
  const order = (a, b) => (a.target === 'home' ? -1 : b.target === 'home' ? 1 : 0) || LAST(a.target) - LAST(b.target) || b.value - a.value;

  for (let c = 0; c < ncol; c++) {
    const col = [...byId.values()].filter((n) => n.col === c);
    for (const n of col) n.anchor = n.in.length ? Math.min(...n.in.map((l) => l.sy)) : 0;
    col.sort((a, b) => a.anchor - b.anchor || LAST(a.id) - LAST(b.id) || b.value - a.value);
    let room = 24;
    const fits = () => col.reduce((s, n) => s + Math.max(n.h, room) + 4, 0) <= avail;
    while (room > 14 && !fits()) room -= 1;
    if (c === 0 || col.every((n) => !n.in.length)) {
      const gap = 16;
      let y = pad + (avail - col.reduce((s, n) => s + n.h, 0) - gap * (col.length - 1)) / 2;
      for (const n of col) { n.top = y; y += n.h + gap; }
    } else {
      let floor = pad;
      for (const n of col) {
        const slot = Math.max(n.h, room);
        n.top = Math.max(n.anchor, floor + (slot - n.h) / 2);
        floor = n.top + n.h + (slot - n.h) / 2 + 4;
      }
      const over = floor - 4 - (H - pad);
      if (over > 0) for (const n of col) n.top -= over;
    }
    for (const n of col) {
      let y = n.top;
      for (const l of n.out.sort(order)) { l.sy = y; y += l.w; }
    }
  }
  for (const n of byId.values()) {
    let y = n.top;
    for (const l of n.in.sort((a, b) => a.sy - b.sy)) { l.ty = y; y += l.w; }
  }
  const streams = links.map((l) => {
    const s = byId.get(l.source);
    const t = byId.get(l.target);
    return { key: `${l.source}>${l.target}`, w: l.value, color: l.target === 'home' ? s.color : t.color, c0: s.col, c1: t.col,
      xs: [s.x, s.x, t.x], a: [l.sy, l.sy + l.w], b: [l.ty, l.ty + l.w] };
  });
  return { ncol, nodes: [...byId.values()], streams };
}

// The same curve as the SVG path, so particles stay on their stream.
const bez = (p0, p1, p2, p3, u) => {
  const v = 1 - u;
  return v * v * v * p0 + 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u * p3;
};
export function pointAt(s, f, u) {
  const [xa, xb, xc] = s.xs;
  const ya = s.a[0] + (s.a[1] - s.a[0]) * f;
  const yb = s.b[0] + (s.b[1] - s.b[0]) * f;
  const run = xb - xa;
  const total = run + (xc - xb);
  const d = u * total;
  if (d <= run) return [xa + d, ya];
  const v = run >= total ? 1 : (d - run) / (xc - xb);
  const xm = (xb + xc) / 2;
  return [bez(xb, xm, xm, xc, v), bez(ya, ya, yb, yb, v)];
}

class EdgelitEnergyCard extends HTMLElement {
  setConfig(config) {
    this._config = { group_by_area: true, group_by_floor: true, max_devices: MAX_DEVICES, ...config };
    this._prefs = null;
    this._particles = new Map();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._init();
    const wait = UPDATE_MS - (Date.now() - (this._updated || 0));
    if (wait <= 0) this._update();
    else this._pending ||= setTimeout(() => { this._pending = null; this._update(); }, wait);
  }

  connectedCallback() { if (this._hass && !this._timer) this._init(); }
  disconnectedCallback() {
    clearInterval(this._timer); this._timer = null;
    cancelAnimationFrame(this._raf); this._raf = null;
    this._ro?.disconnect();
    document.removeEventListener('visibilitychange', this._onVis);
  }
  getCardSize() { return 12; }

  _init() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' }).innerHTML = `<style>${STYLE}</style>
        <div id="main"><header><div class="title" id="title"></div><div class="pill" id="total"></div></header>
        <div id="flow"><svg id="svg"></svg><canvas id="cv"></canvas></div></div>`;
      this.shadowRoot.addEventListener('click', (e) => {
        const el = e.target.closest('[data-id]');
        if (el) this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId: el.dataset.id }, bubbles: true, composed: true }));
      });
      if (!document.querySelector(`link[href="${FONT}"]`)) document.head.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="${FONT}">`);
      this._onVis = () => (document.hidden ? (cancelAnimationFrame(this._raf), this._raf = null) : this._loop());
    }
    if (this._timer) return;
    this._loadPrefs();
    this._timer = setInterval(() => this._loadPrefs(), PREFS_MS);
    document.addEventListener('visibilitychange', this._onVis);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => { this._size = null; this._draw(); });
      this._ro.observe(this.shadowRoot.getElementById('flow'));
    }
    this._loop();
  }

  async _loadPrefs() {
    try {
      this._prefs = await this._hass.callWS({ type: 'energy/get_prefs' });
      this._update();
    } catch (e) {
      console.warn('edgelit-energy-card: energy/get_prefs failed', e);
    }
  }

  _update() {
    if (!this._prefs || !this._hass) return;
    this._updated = Date.now();
    const c = this._config;
    this._from = this._shown || null;
    this._target = buildGraph(this._prefs, this._hass, { groupByArea: c.group_by_area, groupByFloor: c.group_by_floor, maxDevices: c.max_devices, colors: c.colors });
    this._easeStart = performance.now();
    const rate = c.price ? parseFloat(this._hass.states[c.price]?.state) : NaN;
    const use = this._target.used;
    const $ = (id) => this.shadowRoot.getElementById(id);
    $('title').textContent = c.title || 'WHERE YOUR POWER IS GOING';
    $('total').innerHTML = `<b>${fmtW(use)}</b>${Number.isNaN(rate) ? '' : `<span class="dim">$${((use / 1000) * rate).toFixed(2)}/hr</span>`}`;
  }

  _loop() {
    if (this._raf || document.hidden) return;
    let last = performance.now();
    const tick = (now) => {
      this._raf = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      const dt = Math.min(now - last, 200) / 1000;
      last = now;
      if (this._target && this._shown !== this._target) this._draw(now);
      this._animate(dt);
    };
    this._raf = requestAnimationFrame(tick);
  }

  _draw(now = performance.now()) {
    if (!this._target) return;
    if (!this._size) {
      const r = this.shadowRoot.getElementById('flow').getBoundingClientRect();
      if (!r.width || !r.height) return;
      this._size = [r.width, r.height];
      const cv = this.shadowRoot.getElementById('cv');
      const dpr = window.devicePixelRatio || 1;
      cv.width = r.width * dpr; cv.height = r.height * dpr;
      cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const k = Math.min((now - this._easeStart) / EASE_MS, 1);
    const graph = easeGraph(this._from, this._target, k * k * (3 - 2 * k));
    if (k >= 1) this._shown = this._target;
    this._geo = layout(graph, ...this._size);
    this.shadowRoot.getElementById('svg').innerHTML = this._svg(this._geo);
  }

  _svg(g) {
    const op = (c) => (0.1 + (0.5 * c) / (g.ncol - 1)).toFixed(2);
    const defs = [];
    const paths = g.streams.map((s, i) => {
      const [x0, , x1] = s.xs;
      const xm = (x0 + x1) / 2;
      const [ya, yb] = s.a;
      const [ta, tb] = s.b;
      defs.push(`<linearGradient id="g${i}" gradientUnits="userSpaceOnUse" x1="${x0}" x2="${x1}"><stop offset="0" stop-color="${s.color}" stop-opacity="${op(s.c0)}"/><stop offset="1" stop-color="${s.color}" stop-opacity="${op(s.c1)}"/></linearGradient>`);
      return `<path d="M${x0},${ya} C${xm},${ya} ${xm},${ta} ${x1},${ta} L${x1},${tb} C${xm},${tb} ${xm},${yb} ${x0},${yb}Z" fill="url(#g${i})"/>`;
    });
    const items = g.nodes.map((n) => {
      const cy = n.top + n.h / 2;
      const attr = n.entityId ? ` data-id="${esc(n.entityId)}"` : '';
      const line = `<line x1="${n.x}" x2="${n.x}" y1="${n.top}" y2="${n.top + Math.max(n.h, 1)}" stroke="${n.color}" stroke-width="3" stroke-linecap="round"/>`;
      if (n.id === 'home') return `${line}<text x="${n.x}" y="${n.top - 12}" class="home">Home · ${fmtW(n.value)}</text>`;
      if (n.col === 0) return `<g${attr}>${line}<text x="${n.x - 16}" y="${cy - 2}" class="src">${esc(n.label)}</text><text x="${n.x - 16}" y="${cy + 18}" class="srcv">${fmtW(n.value)}</text></g>`;
      const big = n.h >= 18;
      const text = `<text x="${n.x + 16}" y="${cy + 5.5}" class="${big ? 'lb' : 'ls'}${n.dead ? ' dead' : ''}">${esc(n.label)} <tspan class="v">${fmtW(n.value)}</tspan></text>`;
      if (!n.out.length) return `<g${attr}>${line}${text}</g>`;
      const w = (n.label.length + fmtW(n.value).length + 1) * (big ? 9.5 : 8) + 16;
      return `<g${attr}>${line}<rect x="${n.x + 8}" y="${cy - 14}" width="${w}" height="28" rx="7" class="bd"/>${text}</g>`;
    });
    return `<defs>${defs.join('')}</defs><g class="streams">${paths.join('')}</g>${items.join('')}`;
  }

  // Particles keep `t` across re-layouts, so motion doesn't jump.
  _animate(dt) {
    const cv = this.shadowRoot.getElementById('cv');
    const ctx = cv.getContext?.('2d');
    if (!ctx || !this._geo) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const streams = this._geo.streams.filter((s) => s.w > 0);
    const want = streams.map((s) => particleCount(s.w));
    const sum = want.reduce((a, n) => a + n, 0);
    const k = sum > MAX_PARTICLES ? MAX_PARTICLES / sum : 1;
    const live = new Set();
    ctx.globalCompositeOperation = 'lighter';
    streams.forEach((s, i) => {
      live.add(s.key);
      const n = Math.max(1, Math.floor(want[i] * k));
      const ps = this._particles.get(s.key) || [];
      while (ps.length < n) ps.push({ t: Math.random(), f: 0.15 + Math.random() * 0.7 });
      ps.length = n;
      this._particles.set(s.key, ps);
      const step = dt / crossSeconds(s.w);
      const r = 1.6 + Math.min(s.w / 2000, 1.4);
      ctx.fillStyle = s.color;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 6;
      for (const p of ps) {
        p.t = (p.t + step) % 1;
        const [x, y] = pointAt(s, p.f, p.t);
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    });
    for (const key of this._particles.keys()) if (!live.has(key)) this._particles.delete(key);
  }
}

const STYLE = `
:host { display:block; height: calc(100vh - var(--header-height, 56px)); min-height: 560px; font-family: Manrope, system-ui, sans-serif; color:#e2e8f0; --dim:#7c879b; }
* { box-sizing:border-box; }
#main { height:100%; display:flex; flex-direction:column; padding:14px 20px 10px;
  background: radial-gradient(ellipse at 30% 0%, #141c2b, #0a0e15 70%); }
header { display:flex; justify-content:space-between; align-items:center; }
.title { color:var(--dim); font-size:16px; font-weight:700; letter-spacing:2px; }
.pill { display:flex; align-items:center; gap:10px; height:48px; padding:0 18px; border-radius:16px; background:rgba(30,36,48,.72); border:1px solid rgba(255,255,255,.07); font-size:17px; font-weight:600; }
.pill b { font-size:22px; } .dim { color:var(--dim); font-weight:500; }
#flow { flex:1; min-height:0; position:relative; }
#flow svg, #flow canvas { position:absolute; inset:0; width:100%; height:100%; }
#flow canvas { pointer-events:none; }
.streams path { mix-blend-mode:screen; }
text { font-family: Manrope, system-ui, sans-serif; fill:#e2e8f0; }
.lb { font-size:17px; font-weight:700; } .ls { font-size:14px; font-weight:600; }
.v { fill:var(--dim); font-weight:400; }
.dead { opacity:.45; }
.bd { fill:rgba(10,14,21,.72); }
.home { font-size:16px; font-weight:800; text-anchor:middle; }
.src { font-size:17px; font-weight:800; text-anchor:end; } .srcv { font-size:14px; text-anchor:end; fill:var(--dim); }
[data-id] { cursor:pointer; -webkit-tap-highlight-color:transparent; }
`;

if (!customElements.get('edgelit-energy-card')) {
  customElements.define('edgelit-energy-card', EdgelitEnergyCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'edgelit-energy-card', name: 'Edgelit energy', description: 'Live power flow, built like the Energy dashboard\'s power sankey.' });
}
