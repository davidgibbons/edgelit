// Live power as a flow from the sources through the house to each circuit and
// the devices under it. The tree comes from Home Assistant's Energy settings:
// each device's `stat_rate` is its live power and `included_in_stat` names its
// parent. Plain HTMLElement, no build step (see README.md).

const FONT = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap';
const DEAD = ['unavailable', 'unknown'];
const PALETTE = ['#38bdf8', '#a78bfa', '#34d399', '#f472b6', '#fb923c', '#fbbf24', '#f87171', '#2dd4bf',
  '#818cf8', '#a3e635', '#e879f9', '#60a5fa', '#facc15', '#c084fc', '#5eead4', '#fda4af', '#93c5fd'];
const OTHER = '#94a3b8';
const UNTRACKED = '#64748b';
const CHARGING = '#4ade80';
const MAX_PARTICLES = 150;
const FRAME_MS = 1000 / 30;
const UPDATE_MS = 5000;
const EASE_MS = 1000;
const PREFS_MS = 5 * 60000;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// A power state in watts, or null when it has no usable value.
export const watts = (s) => {
  if (!s || DEAD.includes(s.state)) return null;
  const v = parseFloat(s.state);
  if (Number.isNaN(v)) return null;
  return /^kW$/i.test(s.attributes?.unit_of_measurement || '') ? v * 1000 : v;
};

export const fmtW = (w) => (w >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`);

// Seconds for a particle to cross a stream carrying `w` watts, and how many
// particles ride it.
export const crossSeconds = (w) => 2.5 * (2400 / Math.max(w, 1)) ** 0.35;
export const particleCount = (w) => Math.max(2, Math.round(Math.sqrt(w) / 5));

// The i-th child of a circuit: the circuit's color, lighter or darker by turns.
export const shade = (hex, i) => {
  const n = parseInt(hex.slice(1), 16);
  const k = ((i % 2 ? -1 : 1) * (0.18 + 0.12 * Math.floor(i / 2)));
  const ch = (v) => Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k));
  return `#${[n >> 16, (n >> 8) & 255, n & 255].map((v) => ch(v).toString(16).padStart(2, '0')).join('')}`;
};

// The flow tree from `energy/get_prefs` and the current states: live sources,
// the total through the house, and tier-1 nodes (circuits, plus a charging
// battery, "Other" and "Untracked") each with tier-2 children.
export function buildTree(prefs, states, { home, minWatts = 100, colors = {} } = {}) {
  const sources = [];
  let charging = 0;
  let battery = null;
  for (const s of prefs?.energy_sources || []) {
    if (!s.stat_rate || (s.type !== 'grid' && s.type !== 'battery')) continue;
    const v = watts(states[s.stat_rate]);
    const name = s.name || (s.type === 'grid' ? 'Grid' : 'Battery');
    if (s.type === 'battery') battery = { id: s.stat_rate, w: v ?? 0 };
    // A charging battery is a load on the house; exporting grid power is ignored.
    if (s.type === 'battery' && v < 0) charging += -v;
    else if (v > 0) sources.push({ key: `src:${s.stat_rate}`, name, id: s.stat_rate, w: v });
  }

  const devs = (prefs?.device_consumption || []).filter((d) => d.stat_rate);
  const byStat = new Map(devs.map((d) => [d.stat_consumption, d]));
  const node = (d, color) => {
    const w = watts(states[d.stat_rate]);
    return { key: d.stat_rate, name: d.name || d.stat_consumption, id: d.stat_rate, w: Math.max(w ?? 0, 0), dead: w === null, color: colors[d.name] || color, children: [] };
  };
  const tier1 = devs.filter((d) => !byStat.has(d.included_in_stat));
  const nodes = tier1.map((d, i) => node(d, PALETTE[i % PALETTE.length]));
  const byId = new Map(tier1.map((d, i) => [d.stat_consumption, nodes[i]]));
  for (const d of devs) {
    const parent = byId.get(d.included_in_stat);
    if (parent) parent.children.push(node(d, null));
  }
  for (const n of nodes) {
    const kept = n.children.filter((c) => c.w >= minWatts).sort((a, b) => b.w - a.w);
    kept.forEach((c, i) => { c.key = `${n.key}/${c.key}`; c.color ||= shade(n.color, i); });
    const rest = n.w - kept.reduce((a, c) => a + c.w, 0);
    if (kept.length && rest >= minWatts) kept.push({ key: `${n.key}/untracked`, name: 'Untracked', w: rest, color: UNTRACKED, children: [] });
    n.children = kept;
  }
  if (charging > 0) nodes.push({ key: 'charging', name: 'Battery', id: battery.id, w: charging, color: CHARGING, children: [] });

  const homeW = home ? watts(states[home]) : null;
  const total = homeW !== null ? Math.max(homeW, 0) + charging : sources.reduce((a, s) => a + s.w, 0);
  const shown = nodes.filter((n) => n.w >= minWatts).sort((a, b) => b.w - a.w);
  const other = nodes.filter((n) => n.w < minWatts).reduce((a, n) => a + n.w, 0);
  if (other > 0) shown.push({ key: 'other', name: 'Other', w: other, color: colors.Other || OTHER, children: [] });
  const untracked = total - nodes.reduce((a, n) => a + n.w, 0);
  if (untracked > 0) shown.push({ key: 'untracked', name: 'Untracked', w: untracked, color: colors.Untracked || UNTRACKED, children: [] });
  return { sources, battery, charging, total, nodes: shown };
}

// `to` with every power moved `k` of the way from its value in `from`, so
// stream widths ease instead of jumping. Nodes new to `to` grow from zero.
export function easeTree(from, to, k) {
  if (!from || k >= 1) return to;
  const old = new Map();
  const walk = (list) => (list || []).forEach((n) => { old.set(n.key, n.w); walk(n.children); });
  walk(from.sources); walk(from.nodes);
  const mix = (n) => ({ ...n, w: (old.get(n.key) ?? 0) + (n.w - (old.get(n.key) ?? 0)) * k, children: (n.children || []).map(mix) });
  return { ...to, total: from.total + (to.total - from.total) * k, sources: to.sources.map(mix), nodes: to.nodes.map(mix) };
}

// Node and stream geometry for a W×H box. Streams carry x0..x3 and the band
// edges the particles ride between.
export function layout(tree, W, H) {
  const pad = 24;
  const avail = H - 2 * pad;
  const hasKids = tree.nodes.some((n) => n.children.length);
  const x0 = W * 0.1;
  const x1 = W * 0.33;
  const x2 = W * (hasKids ? 0.6 : 0.78);
  const x3 = W * 0.84;
  // Meter skew can put the loads above the sources; size for the larger.
  const total = Math.max(tree.total, tree.nodes.reduce((a, n) => a + n.w, 0));
  const scale = total > 0 ? (avail * 0.7) / total : 0;
  const hh = total * scale;
  const homeTop = pad + (avail - hh) / 2;

  // Each node gets room for its label; shrink that room when many nodes crowd.
  let room = 24;
  const fit = () => tree.nodes.reduce((a, n) => a + Math.max(n.w * scale, room) + 4, 0) > avail;
  while (room > 14 && fit()) room -= 1;
  const slots = tree.nodes.map((n) => Math.max(n.w * scale, room));
  const gap = tree.nodes.length > 1 ? Math.max((avail - slots.reduce((a, s) => a + s, 0)) / (tree.nodes.length - 1), 4) : 0;
  let y = pad;
  let hy = homeTop;
  const streams = [];
  const nodes = tree.nodes.map((n, i) => {
    const h = n.w * scale;
    const top = y + (slots[i] - h) / 2;
    y += slots[i] + gap;
    const s = { key: n.key, w: n.w, color: n.color, xs: [x0, x1, x2], a: [hy, hy + h], b: [top, top + h], tier: 1 };
    hy += h;
    streams.push(s);
    return { ...n, x: x2, top, h, stream: s };
  });

  const kids = [];
  let floor = pad;
  for (const n of nodes) {
    if (!n.children.length) continue;
    const hs = n.children.map((c) => c.w * scale);
    const slot = hs.map((h) => Math.max(h, 22));
    const block = slot.reduce((a, s) => a + s, 0) + 6 * (slot.length - 1);
    let cy = Math.max(n.top + n.h / 2 - block / 2, floor);
    let from = n.top;
    n.children.forEach((c, i) => {
      const top = cy + (slot[i] - hs[i]) / 2;
      const s = { key: c.key, w: c.w, color: c.color, xs: [x2, x2, x3], a: [from, from + hs[i]], b: [top, top + hs[i]], tier: 2 };
      streams.push(s);
      kids.push({ ...c, x: x3, top, h: hs[i], stream: s });
      from += hs[i];
      cy += slot[i] + 6;
    });
    floor = cy + 4;
  }
  // Push the device column back up if it ran off the bottom.
  const over = kids.length ? kids[kids.length - 1].top + kids[kids.length - 1].h - (H - pad) : 0;
  if (over > 0) kids.forEach((k) => { k.top -= over; k.stream.b = [k.stream.b[0] - over, k.stream.b[1] - over]; });

  const sum = tree.sources.reduce((a, s) => a + s.w, 0) || 1;
  let sy = homeTop;
  const sources = tree.sources.map((s) => {
    const h = (s.w / sum) * hh;
    const out = { ...s, top: sy, h };
    sy += h;
    return out;
  });
  return { W, H, x0, x1, x2, x3, homeTop, hh, nodes, kids, sources, streams };
}

// Point at parameter u ∈ [0, 1] along a stream's centerline at fraction f of
// its width: a straight run from xs[0] to xs[1], then a flat cubic to xs[2].
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
    this._config = { min_watts: 100, ...config };
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

  // Take new power values and start easing toward them.
  _update() {
    if (!this._prefs || !this._hass) return;
    this._updated = Date.now();
    const c = this._config;
    this._from = this._shown || null;
    this._target = buildTree(this._prefs, this._hass.states, { home: c.home, minWatts: c.min_watts, colors: c.colors });
    this._easeStart = performance.now();
    const rate = c.price ? parseFloat(this._hass.states[c.price]?.state) : NaN;
    const use = this._target.total - this._target.charging;
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
      if (this._target && (this._shown !== this._target)) this._draw(now);
      this._animate(dt);
    };
    this._raf = requestAnimationFrame(tick);
  }

  // Rebuild the streams from the eased tree.
  _draw(now = performance.now()) {
    if (!this._target) return;
    const flow = this.shadowRoot.getElementById('flow');
    if (!this._size) {
      const r = flow.getBoundingClientRect();
      if (!r.width || !r.height) return;
      this._size = [r.width, r.height];
      const cv = this.shadowRoot.getElementById('cv');
      const dpr = window.devicePixelRatio || 1;
      cv.width = r.width * dpr; cv.height = r.height * dpr;
      cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const k = Math.min((now - this._easeStart) / EASE_MS, 1);
    const tree = easeTree(this._from, this._target, k * k * (3 - 2 * k));
    if (k >= 1) this._shown = this._target;
    this._geo = layout(tree, ...this._size);
    this.shadowRoot.getElementById('svg').innerHTML = this._svg(this._geo, tree);
  }

  _svg(g, tree) {
    const { x0, x1, x2, x3, homeTop, hh } = g;
    const xm = (x1 + x2) / 2;
    const xk = (x2 + x3) / 2;
    const defs = [];
    const paths = [];
    for (const [i, s] of g.streams.entries()) {
      const [ya, yb] = s.a;
      const [ta, tb] = s.b;
      if (s.tier === 1) {
        const mid = (x1 - x0) / (x2 - x0);
        defs.push(`<linearGradient id="g${i}" gradientUnits="userSpaceOnUse" x1="${x0}" x2="${x2}"><stop offset="0" stop-color="${s.color}" stop-opacity=".10"/><stop offset="${mid}" stop-color="${s.color}" stop-opacity=".22"/><stop offset="1" stop-color="${s.color}" stop-opacity=".6"/></linearGradient>`);
        paths.push(`<path d="M${x0},${ya} L${x1},${ya} C${xm},${ya} ${xm},${ta} ${x2},${ta} L${x2},${tb} C${xm},${tb} ${xm},${yb} ${x1},${yb} L${x0},${yb}Z" fill="url(#g${i})"/>`);
      } else {
        defs.push(`<linearGradient id="g${i}" gradientUnits="userSpaceOnUse" x1="${x2}" x2="${x3}"><stop offset="0" stop-color="${s.color}" stop-opacity=".25"/><stop offset="1" stop-color="${s.color}" stop-opacity=".6"/></linearGradient>`);
        paths.push(`<path d="M${x2},${ya} C${xk},${ya} ${xk},${ta} ${x3},${ta} L${x3},${tb} C${xk},${tb} ${xk},${yb} ${x2},${yb}Z" fill="url(#g${i})"/>`);
      }
    }
    // The source column is striped with the colors of the streams leaving it.
    const stops = g.nodes.flatMap((n) => {
      const a = hh ? (n.stream.a[0] - homeTop) / hh : 0;
      const b = hh ? (n.stream.a[1] - homeTop) / hh : 0;
      return [`<stop offset="${a}" stop-color="${n.color}"/>`, `<stop offset="${b}" stop-color="${n.color}"/>`];
    });
    defs.push(`<linearGradient id="stripe" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${homeTop}" y2="${homeTop + hh}">${stops.join('')}</linearGradient>`);

    const line = (x, top, h, color) => `<line x1="${x}" x2="${x}" y1="${top}" y2="${top + Math.max(h, 1)}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`;
    const label = (x, y, n, big) => `<text x="${x}" y="${y}" class="${big ? 'lb' : 'ls'}${n.dead ? ' dead' : ''}">${esc(n.name)} <tspan class="v">${fmtW(n.w)}</tspan></text>`;
    const items = [];
    for (const n of g.nodes) {
      const cy = n.top + n.h / 2;
      const big = n.h >= 18;
      const attr = n.id ? ` data-id="${esc(n.id)}"` : '';
      if (n.children.length) {
        const w = (n.name.length + fmtW(n.w).length + 1) * (big ? 9.5 : 8) + 16;
        items.push(`<g${attr}>${line(n.x, n.top, n.h, n.color)}<rect x="${n.x + 8}" y="${cy - 14}" width="${w}" height="28" rx="7" class="bd"/>${label(n.x + 16, cy + 5.5, n, big)}</g>`);
      } else {
        items.push(`<g${attr}>${line(n.x, n.top, n.h, n.color)}${label(n.x + 16, cy + 5.5, n, big)}</g>`);
      }
    }
    for (const c of g.kids) {
      const attr = c.id ? ` data-id="${esc(c.id)}"` : '';
      items.push(`<g${attr}>${line(c.x, c.top, c.h, c.color)}${label(c.x + 14, c.top + c.h / 2 + 5, c, false)}</g>`);
    }
    items.push(`<line x1="${x1}" x2="${x1}" y1="${homeTop}" y2="${homeTop + hh}" stroke="#e2e8f0" stroke-width="2" stroke-linecap="round" opacity=".8"/>`);
    items.push(`<text x="${x1}" y="${homeTop - 12}" class="home">Home · ${fmtW(tree.total - tree.charging)}</text>`);
    for (const s of g.sources) {
      items.push(`<g data-id="${esc(s.id)}"><line x1="${x0}" x2="${x0}" y1="${s.top + 2}" y2="${s.top + Math.max(s.h - 2, 1)}" stroke="url(#stripe)" stroke-width="3" stroke-linecap="round"/>
        <text x="${x0 - 16}" y="${s.top + s.h / 2 - 2}" class="src">${esc(s.name)}</text><text x="${x0 - 16}" y="${s.top + s.h / 2 + 18}" class="srcv">${fmtW(s.w)}</text></g>`);
    }
    const bat = tree.battery;
    if (bat && Math.abs(bat.w) < 10) items.push(`<text x="${x0 - 16}" y="${homeTop + hh + 30}" class="idle" data-id="${esc(bat.id)}">Battery idle</text>`);
    return `<defs>${defs.join('')}</defs><g class="streams">${paths.join('')}</g>${items.join('')}`;
  }

  // Move the particles and paint them. Each keeps its place `t` along its
  // stream, so motion carries on through re-layouts.
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
.idle { font-size:13px; text-anchor:end; fill:#34d399; opacity:.7; }
[data-id] { cursor:pointer; -webkit-tap-highlight-color:transparent; }
`;

if (!customElements.get('edgelit-energy-card')) {
  customElements.define('edgelit-energy-card', EdgelitEnergyCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'edgelit-energy-card', name: 'Edgelit energy', description: 'Live power flow from the Energy settings tree.' });
}
