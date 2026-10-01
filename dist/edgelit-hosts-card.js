// System tabs for the control panel, in the edgelit-panel-card look: one card
// per host with power and cost from Home Assistant, and load, memory, pods and
// inference activity from VictoriaMetrics. Plain HTMLElement, no build step: HA
// loads this file as a module resource. Configuration lives in the dashboard
// (see README.md).

const FONT = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap';
const DEAD = ['unavailable', 'unknown'];
const DAY = 86400000;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Pod name without the controller's suffix: Deployment `-<hash>-<5>`, CronJob
// `-<epoch-minutes>-<5>`, DaemonSet `-<5>`. StatefulSet ordinals stay.
export const workloadName = (pod) => String(pod).replace(/(-[0-9a-f]{8,10})?-[a-z0-9]{5}$/, '');

// $/hr for a draw in watts at a $/kWh rate.
export const costPerHour = (watts, rate) => (watts / 1000) * rate;

// Watt-hours since `since` (ms) from recorder 5-minute means.
export const wattHours = (pts, since) => (pts || []).reduce((wh, p) => {
  const ts = typeof p.start === 'number' ? p.start : Date.parse(p.start);
  return ts >= since && p.mean != null ? wh + (p.mean * 5) / 60 : wh;
}, 0);

// A VictoriaMetrics instant-query result as rows of {labels, value}.
export const rows = (res) => (res?.data?.result || []).map((r) => ({ labels: r.metric, value: parseFloat(r.value[1]) }));

// The first value per key label, as a Map.
export const byLabel = (res, label) => new Map(rows(res).map((r) => [r.labels[label], r.value]));

export const fmtUptime = (secs) => (secs >= DAY / 1000 ? `${Math.floor(secs / 86400)}d` : `${Math.floor(secs / 3600)}h`);

export const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`);

class EdgelitHostsCard extends HTMLElement {
  setConfig(config) {
    for (const key of ['prometheus', 'rate', 'hosts']) {
      if (!config[key]) throw new Error(`edgelit-hosts-card: \`${key}\` is required`);
    }
    this._config = { ...config, prometheus: config.prometheus.replace(/\/+$/, '') };
    this._seen = new Map();
    this._vm = {};
    this._cpu24 = null;
    this._stats = null;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._init();
    let changed = false;
    for (const id of this._watched()) {
      const s = hass.states[id];
      if (this._seen.get(id) !== s) { this._seen.set(id, s); changed = true; }
    }
    if (changed) this._render();
  }

  connectedCallback() { if (this._hass && !this._timers) this._init(); }
  disconnectedCallback() { (this._timers || []).forEach(clearInterval); this._timers = null; }
  getCardSize() { return 12; }

  _init() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' }).innerHTML = `<style>${STYLE}</style><div id="main"></div>`;
      this.shadowRoot.addEventListener('click', (e) => {
        const el = e.target.closest('[data-id]');
        if (el) this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId: el.dataset.id }, bubbles: true, composed: true }));
      });
      if (!document.querySelector(`link[href="${FONT}"]`)) document.head.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="${FONT}">`);
    }
    if (this._timers) return;
    const slow = () => { this._loadStats(); this._loadCpu24(); };
    this._loadVm(); slow();
    this._timers = [setInterval(() => this._render(), 15000), setInterval(() => this._loadVm(), 30000), setInterval(slow, 5 * 60000)];
  }

  // ---- data ---------------------------------------------------------------

  _hosts() { return this._config.hosts || []; }
  _powers() { return [...this._hosts().map((h) => h.power), this._config.infra?.switch].filter(Boolean); }
  _watched() {
    const c = this._config;
    return [...this._powers(), c.rate, c.infra?.air_top, c.infra?.air_bottom, ...Object.values(c.usage || {})].filter(Boolean);
  }
  _st(id) { return id ? this._hass.states[id] : undefined; }
  _num(id) { const s = this._st(id); return s && !DEAD.includes(s.state) ? parseFloat(s.state) : NaN; }
  _rate() { return this._num(this._config.rate); }

  async _query(expr) {
    try {
      const r = await fetch(`${this._config.prometheus}/api/v1/query?query=${encodeURIComponent(expr)}`);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  // One request per expression, so a bad query blanks only its own field.
  async _loadVm() {
    const n = this._hosts().map((h) => h.node).join('|');
    const k8s = (m) => `${m} * on(namespace,pod) group_left(node) kube_pod_info{node=~"${n}"}`;
    const since = Math.max(60, Math.round((Date.now() - new Date().setHours(0, 0, 0, 0)) / 1000));
    const q = {
      cpu: `100 * (1 - avg by (nodename) (rate(node_cpu_seconds_total{mode="idle",nodename=~"${n}"}[2m])))`,
      cores: `count by (nodename) (node_cpu_seconds_total{mode="idle",nodename=~"${n}"})`,
      memTotal: `sum by (nodename) (node_memory_MemTotal_bytes{nodename=~"${n}"})`,
      memAvail: `sum by (nodename) (node_memory_MemAvailable_bytes{nodename=~"${n}"})`,
      memFree: `sum by (nodename) (node_memory_MemFree_bytes{nodename=~"${n}"})`,
      temp: `max by (nodename, chip) (node_hwmon_temp_celsius{nodename=~"${n}"})`,
      up: `max by (nodename) (time() - node_boot_time_seconds{nodename=~"${n}"})`,
      ready: `max by (node) (kube_node_status_condition{condition="Ready",status="true",node=~"${n}"})`,
      running: `sum by (node) (${k8s('kube_pod_status_phase{phase="Running"}')})`,
      pending: `sum by (node) (${k8s('kube_pod_status_phase{phase="Pending"}')})`,
      crash: `max by (node, namespace, pod) (${k8s('kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"}')})`,
      top: `topk by (node) (3, sum by (node, namespace, pod) (rate(container_cpu_usage_seconds_total{container!="",node=~"${n}"}[5m])))`,
    };
    if (this._config.infra?.ceph) {
      Object.assign(q, {
        cephHealth: 'max(ceph_health_status)',
        cephUsed: 'sum(ceph_cluster_total_used_bytes)',
        cephTotal: 'sum(ceph_cluster_total_bytes)',
        cephRd: 'sum(rate(ceph_pool_rd_bytes[2m]))',
        cephWr: 'sum(rate(ceph_pool_wr_bytes[2m]))',
      });
    }
    if (this._config.infra?.alerts) q.alerts = 'count by (alertname) (ALERTS{alertstate="firing",alertname!~"Watchdog|InfoInhibitor"})';
    if (this._hosts().some((h) => h.inference)) {
      Object.assign(q, {
        vRun: 'sum by (nodename, model_name) (vllm:num_requests_running)',
        vWait: 'sum by (nodename, model_name) (vllm:num_requests_waiting)',
        vTps: 'sum by (nodename, model_name) (rate(vllm:generation_tokens_total[2m]))',
        vToday: `sum by (nodename, model_name) (increase(vllm:generation_tokens_total[${since}s]))`,
        vKv: 'max by (nodename, model_name) (vllm:kv_cache_usage_perc)',
        vP50: 'histogram_quantile(0.5, sum by (le, nodename, model_name) (rate(vllm:e2e_request_latency_seconds_bucket[15m])))',
        lRun: 'sum by (nodename, service) (llamacpp:requests_processing)',
        lWait: 'sum by (nodename, service) (llamacpp:requests_deferred)',
        lTps: 'sum by (nodename, service) (rate(llamacpp:tokens_predicted_total[2m]))',
        lToday: `sum by (nodename, service) (increase(llamacpp:tokens_predicted_total[${since}s]))`,
      });
    }
    const keys = Object.keys(q);
    const res = await Promise.all(keys.map((k) => this._query(q[k])));
    this._vm = Object.fromEntries(keys.map((k, i) => [k, res[i]]));
    this._vmDown = res.every((r) => r === null);
    this._render();
  }

  async _loadCpu24() {
    const n = this._hosts().map((h) => h.node).join('|');
    const end = Math.floor(Date.now() / 1000);
    const expr = `100 * (1 - avg by (nodename) (rate(node_cpu_seconds_total{mode="idle",nodename=~"${n}"}[15m])))`;
    try {
      const r = await fetch(`${this._config.prometheus}/api/v1/query_range?query=${encodeURIComponent(expr)}&start=${end - 86400}&end=${end}&step=900`);
      const j = r.ok ? await r.json() : null;
      this._cpu24 = new Map((j?.data?.result || []).map((s) => [s.metric.nodename, s.values.map(([t, v]) => [t * 1000, parseFloat(v)])]));
    } catch { this._cpu24 = null; }
    this._render();
  }

  async _loadStats() {
    try {
      this._stats = await this._hass.callWS({
        type: 'recorder/statistics_during_period', start_time: new Date(Date.now() - DAY).toISOString(),
        statistic_ids: this._powers(), period: '5minute', types: ['mean'],
      });
    } catch (err) {
      this._stats = { error: String(err.message || err) };
    }
    this._render();
  }

  // Everything one host card shows, from whatever answered.
  _model(h) {
    const v = this._vm;
    const at = (k, label = 'nodename') => byLabel(v[k], label).get(h.node);
    const total = at('memTotal');
    const avail = at('memAvail');
    const temps = rows(v.temp).filter((r) => r.labels.nodename === h.node);
    const chip = h.temp_chip || 'platform_coretemp_0';
    const nvme = temps.filter((r) => r.labels.chip.startsWith('nvme')).map((r) => r.value);
    const m = {
      cpu: at('cpu'), cores: at('cores'), total, used: total - avail, cache: avail - at('memFree'),
      temp: temps.find((r) => r.labels.chip === chip)?.value, nvme: nvme.length ? Math.max(...nvme) : undefined,
      up: at('up'), ready: at('ready', 'node'), running: at('running', 'node'), pending: at('pending', 'node'),
      crash: rows(v.crash).filter((r) => r.labels.node === h.node).map((r) => workloadName(r.labels.pod)),
      top: rows(v.top).filter((r) => r.labels.node === h.node).sort((a, b) => b.value - a.value).map((r) => [workloadName(r.labels.pod), r.value]),
    };
    if (h.inference) {
      const pick = (k, label) => rows(v[k]).find((r) => r.labels.nodename === h.node && r.labels[label]);
      const vt = pick('vTps', 'model_name');
      const lt = pick('lTps', 'service');
      if (vt) {
        const get = (k) => rows(v[k]).find((r) => r.labels.nodename === h.node && r.labels.model_name === vt.labels.model_name)?.value;
        m.model = { name: vt.labels.model_name, engine: 'vLLM', tps: vt.value, run: get('vRun'), wait: get('vWait'), today: get('vToday'), kv: get('vKv'), p50: get('vP50') };
      } else if (lt) {
        const get = (k) => rows(v[k]).find((r) => r.labels.nodename === h.node && r.labels.service === lt.labels.service)?.value;
        m.model = { name: lt.labels.service, engine: 'llama.cpp', tps: lt.value, run: get('lRun'), wait: get('lWait'), today: get('lToday') };
      }
    }
    return m;
  }

  // ---- render -------------------------------------------------------------

  _render() {
    if (!this.shadowRoot || !this._hass || !this._config) return;
    const c = this._config;
    const hosts = this._hosts();
    const rate = this._rate();
    const watts = this._powers().reduce((a, id) => a + (Number.isNaN(this._num(id)) ? 0 : this._num(id)), 0);
    const day0 = new Date().setHours(0, 0, 0, 0);
    const wh = this._stats && !this._stats.error ? this._powers().reduce((a, id) => a + wattHours(this._stats[id], day0), 0) : NaN;
    const models = hosts.map((h) => [h, this._model(h)]);
    const money = (v, d = 3) => (Number.isNaN(v) ? '—' : `$${v.toFixed(d)}`);
    const [time, ampm] = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).split(' ');

    let health;
    if (this._vmDown) {
      health = '<div class="pill"><i class="dot warn"></i>Metrics unavailable</div>';
    } else if (c.infra?.alerts) {
      const alerts = rows(this._vm.alerts).length;
      const crashes = models.reduce((a, [, m]) => a + m.crash.length, 0);
      const bad = alerts + crashes;
      health = `<div class="pill"><i class="dot ${bad ? 'warn' : ''}"></i>${bad ? `${alerts} alert${alerts === 1 ? '' : 's'} · ${crashes} crashloop${crashes === 1 ? '' : 's'}` : 'All healthy'}</div>`;
    } else {
      const loaded = models.filter(([h, m]) => h.inference && m.model).length;
      health = `<div class="pill"><i class="dot"></i>${loaded} / ${hosts.filter((h) => h.inference).length} models loaded</div>`;
    }

    const cols = ['1.5fr', ...hosts.map((h) => (h.inference ? '1.25fr' : '1fr')), c.infra || c.usage ? '0.95fr' : ''].join(' ');
    this.shadowRoot.getElementById('main').innerHTML = `
      <header>
        <div><h1>${esc(c.title || 'Hosts')}</h1><div class="sub">${esc(c.subtitle || '')}</div></div>
        <div class="hright">
          <div class="pill"><ha-icon icon="mdi:flash" style="color:#fbbf24"></ha-icon><b>${Math.round(watts)} W</b><span class="dim">${money(costPerHour(watts, rate))}/hr</span></div>
          <div class="pill"><b>${Number.isNaN(wh) ? '—' : (wh / 1000).toFixed(2)} kWh</b><span class="dim">today · ${money((wh / 1000) * rate, 2)}</span></div>
          ${health}
          <div class="clock">${esc(time)}${ampm ? `<small>${esc(ampm)}</small>` : ''}</div>
        </div></header>
      <div class="grid" style="grid-template-columns:${cols}">
        <section>${this._chart()}</section>
        ${models.map(([h, m]) => this._host(h, m, rate, day0)).join('')}
        ${c.infra ? this._infra(rate) : c.usage ? this._usage() : ''}
      </div>`;
  }

  _host(h, m, rate, day0) {
    const w = this._num(h.power);
    const ok = !Number.isNaN(w);
    const color = h.color || '#38bdf8';
    const wh = this._stats && !this._stats.error ? wattHours(this._stats[h.power], day0) : NaN;
    const ready = m.ready === 1;
    const status = m.ready === undefined ? '<span class="dim">—</span>'
      : !ready ? '<span class="bad">● Not ready</span>'
        : m.crash.length ? `<span class="bad">● ${m.crash.length} crashloop${m.crash.length > 1 ? 's' : ''}</span>`
          : `<span class="ok">● Ready${m.up ? ` · ${fmtUptime(m.up)}` : ''}</span>`;
    // Pulse faster as the draw rises: 4 s idle down to 1.2 s at 150 W.
    const pulse = ok ? Math.max(1.2, 4 - (w / 150) * 2.8).toFixed(1) : 0;
    const bar = (label, pct, text, fill) => `<div class="mt"><span class="l">${label}</span><div class="mb">${fill ?? `<i style="width:${Number.isNaN(pct) || pct === undefined ? 0 : Math.min(pct, 100)}%;background:${color}"></i>`}</div><span class="n">${text}</span></div>`;
    const gb = (b) => (b / 1e9).toFixed(0);
    const memPct = (m.used / m.total) * 100;
    const cachePct = (m.cache / m.total) * 100;
    const memBar = bar('MEM', memPct, m.total ? `${gb(m.used)}/${gb(m.total)} G` : '—',
      m.total ? `<i style="width:${memPct}%;background:${color}"></i><i style="width:${Math.min(cachePct, 100 - memPct)}%;background:${color};opacity:.35"></i>` : '');
    const tempBar = bar('TEMP', m.temp, m.temp === undefined ? '—' : `${Math.round(m.temp)}°C`,
      m.temp === undefined ? '' : `<i style="width:${Math.min(m.temp, 100)}%;background:linear-gradient(90deg,#38bdf8,#4ade80 45%,#fbbf24 75%,#f87171)"></i>`);
    const cpuBar = bar('CPU', m.cpu, m.cpu === undefined ? '—' : `${Math.round(m.cpu)}% <span class="dim">${m.cores ?? ''}c</span>`);

    let middle = '';
    let foot;
    if (h.inference) {
      const md = m.model;
      const busy = md && md.tps > 0.5;
      const pips = md ? Array.from({ length: Math.max(4, (md.run || 0) + (md.wait || 0)) }, (_, i) => `<i class="${i < (md.run || 0) ? 'on' : i < (md.run || 0) + (md.wait || 0) ? 'q' : ''}"></i>`).join('') : '';
      middle = `<div class="mdl"><b class="${md ? 'vio' : 'dim'}">${esc(md ? md.name : 'no model loaded')}</b>
          ${md ? `<span class="dim">${md.engine}</span> <span class="chip ${busy ? 'ok' : ''}">${busy ? 'serving' : 'idle'}</span>` : ''}</div>
        <div class="flow"><div class="pips">${pips}</div><div class="ln ${busy ? 'on' : ''}" style="--c:${color}"></div><span class="tps ${busy ? '' : 'dim'}">${md ? md.tps.toFixed(0) : '—'}<small> tok/s</small></span></div>`;
      foot = md
        ? `<b>${fmtTokens(md.today || 0)} tokens today</b> <span class="dim">· ${md.run || 0} running · ${md.wait || 0} queued${md.p50 > 0 ? ` · p50 ${md.p50.toFixed(1)} s` : ''}</span>`
        : '<span class="dim">Scaled to zero; the next request loads it</span>';
    } else {
      foot = `<b>${m.running ?? '—'} pods</b> ${m.crash.length ? `<span class="bad">· ${esc(m.crash.join(', '))} crashlooping</span>` : m.pending ? `<span class="warn">· ${m.pending} pending</span>` : '<span class="dim">all running</span>'}
        <br><span class="dim">${m.top.length ? m.top.map(([n, v]) => `${esc(n)} ${v.toFixed(1)}`).join(' · ') : '—'}</span>`;
    }

    return `<section class="host" data-id="${h.power}" style="--c:${color}">
      <div class="title"><span>${esc(h.name.toUpperCase())}</span><span class="aside">${status}</span></div>
      <div class="top">
        <div class="ring ${ok ? 'on' : ''}" style="${pulse ? `--sp:${pulse}s` : ''}"><div class="v">${ok ? Math.round(w) : '—'}</div><small>W</small></div>
        <div class="cost"><b>${Number.isNaN(costPerHour(w, rate)) ? '—' : `$${costPerHour(w, rate).toFixed(3)}`}/hr</b><span>${Number.isNaN(wh) ? '—' : (wh / 1000).toFixed(2)} kWh today</span></div>
      </div>
      ${middle}
      ${cpuBar}${memBar}${h.inference && m.model?.kv !== undefined ? bar('KV', m.model.kv * 100, `${Math.round(m.model.kv * 100)}%`) : ''}${tempBar}
      ${m.nvme > 65 ? `<div class="hot">NVMe ${Math.round(m.nvme)}°C</div>` : ''}
      ${this._mini(h, color)}
      <div class="note">${foot}</div>
    </section>`;
  }

  // 24h CPU % and power for one host, as two plain lines.
  _mini(h, color) {
    const t0 = Date.now() - DAY;
    const x = (t) => (((t - t0) / DAY) * 100).toFixed(1);
    const line = (pts, max) => pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t)},${(30 - (Math.min(v, max) / max) * 28).toFixed(1)}`).join('');
    const cpu = this._cpu24?.get(h.node) || [];
    const pw = (this._stats?.[h.power] || []).map((p) => [typeof p.start === 'number' ? p.start : Date.parse(p.start), p.mean ?? 0]);
    const pmax = Math.max(10, ...pw.map(([, v]) => v)) * 1.1;
    return `<div class="mini"><div class="lg"><span><i style="background:${color}"></i>power</span><span><i style="background:#cbd5e1"></i>CPU</span><span class="dim">24h</span></div>
      <svg viewBox="0 0 100 30" preserveAspectRatio="none">
        <path d="${line(pw, pmax)}" stroke="${color}" class="s"/>
        <path d="${line(cpu, 100)}" stroke="#cbd5e1" class="s" stroke-dasharray="2 1.5"/>
      </svg></div>`;
  }

  _infra(rate) {
    const i = this._config.infra;
    const v = this._vm;
    const sw = this._num(i.switch);
    const one = (k) => rows(v[k])[0]?.value;
    const health = one('cephHealth');
    const used = one('cephUsed');
    const total = one('cephTotal');
    const io = (one('cephRd') ?? NaN) + (one('cephWr') ?? NaN);
    const alerts = rows(v.alerts).map((r) => r.labels.alertname);
    const air = (id) => (Number.isNaN(this._num(id)) ? '—' : `${Math.round(this._num(id))}°`);
    const row = (k, val, id) => `<div class="irow" ${id ? `data-id="${id}"` : ''}><span class="k">${k}</span><span>${val}</span></div>`;
    return `<section><div class="title"><span>INFRASTRUCTURE</span></div>
      ${i.switch ? row('SWITCH', `<b>${Number.isNaN(sw) ? '—' : Math.round(sw)} W</b> <span class="dim">${Number.isNaN(sw) ? '' : `$${costPerHour(sw, rate).toFixed(3)}/hr`}</span>`, i.switch) : ''}
      ${i.air_top ? row('RACK AIR', `<b>${air(i.air_top)}</b> <span class="dim">top</span> · <b>${air(i.air_bottom)}</b> <span class="dim">bottom</span>`, i.air_top) : ''}
      ${i.ceph ? row('CEPH', health === undefined ? '—' : `<b class="${['ok', 'warn', 'bad'][health]}">${['OK', 'WARN', 'ERR'][health]}</b> <span class="dim">${Math.round((used / total) * 100)}% · ${(used / 1e12).toFixed(1)}/${(total / 1e12).toFixed(1)} TB</span>`) : ''}
      ${i.ceph ? row('CEPH IO', Number.isNaN(io) ? '—' : `<b>${(io / 1e6).toFixed(1)}</b> <span class="dim">MB/s</span>`) : ''}
      ${i.alerts ? `<div class="note">${v.alerts === null || v.alerts === undefined ? '<span class="dim">Alerts unavailable</span>' : alerts.length ? `<b class="warn">⚠ ${alerts.length} alert${alerts.length > 1 ? 's' : ''}</b><br><span class="dim">${esc(alerts.join(' · '))}</span>` : '<span class="ok">No alerts firing</span>'}</div>` : ''}
    </section>`;
  }

  _chart() {
    const ids = this._powers();
    const colors = [...this._hosts().map((h) => h.color || '#38bdf8'), '#3b82f6'];
    const names = [...this._hosts().map((h) => h.name), 'switch'];
    const head = (sub) => `<div class="title"><span>POWER · LAST 24 HOURS</span><span class="aside">${sub}</span></div>`;
    if (!this._stats) return `${head('Loading…')}<div class="plot"></div>`;
    if (this._stats.error) return `${head(`Couldn't load history: ${esc(this._stats.error)}`)}<div class="plot"></div>`;
    const t0 = Date.now() - DAY;
    const toTs = (p) => (typeof p.start === 'number' ? p.start : Date.parse(p.start));
    const maps = ids.map((id) => new Map((this._stats[id] || []).map((p) => [toTs(p), p.mean || 0])));
    const times = [...new Set(maps.flatMap((m) => [...m.keys()]))].sort((a, b) => a - b);
    const cum = ids.map(() => []);
    for (const t of times) {
      let acc = 0;
      maps.forEach((m, i) => { acc += m.get(t) || 0; cum[i].push([t, acc]); });
    }
    const peak = Math.max(10, ...times.map((_, k) => cum.at(-1)?.[k]?.[1] || 0));
    const max = Math.ceil(peak / 50) * 50;
    const W = 1000, H = 300;
    const x = (t) => ((t - t0) / DAY) * W;
    const y = (v) => H - (v / max) * (H - 6);
    const pt = ([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`;
    const band = (i) => {
      if (!times.length) return '';
      const bot = i ? [...cum[i - 1]].reverse() : [[times.at(-1), 0], [times[0], 0]];
      return `M${cum[i].map(pt).join('L')}L${bot.map(pt).join('L')}Z`;
    };
    const areas = ids.map((_, i) => `<path d="${band(i)}" fill="${colors[i]}" fill-opacity=".35" stroke="${colors[i]}" class="s"/>`).join('');
    const ticks = [0, 4, 8, 12, 16, 20, 24].map((k) => `<span style="left:${(k / 24) * 100}%">${k === 24 ? 'now' : new Date(t0 + k * 3600000).toLocaleTimeString([], { hour: 'numeric' })}</span>`).join('');
    const yl = [max, max * 0.75, max / 2, max / 4, 0].map((v, i) => `<span style="top:${i * 25}%">${Math.round(v)}${i === 0 ? ' W' : ''}</span>`).join('');
    return `${head('')}
      <div class="legend">${names.slice(0, ids.length).map((n, i) => `<span><i style="background:${colors[i]}"></i>${esc(n)}</span>`).join('')}<span class="dim">peak ${Math.round(peak)} W</span></div>
      <div class="plot"><div class="yl">${yl}</div>
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${[0, 1, 2, 3, 4].map((i) => `<line x1="0" x2="${W}" y1="${(i * H) / 4}" y2="${(i * H) / 4}" class="gl"/>`).join('')}${areas}</svg>
        <div class="xl">${ticks}</div></div>`;
  }

  // Claude plan usage against how far through each window we are in time.
  _usage() {
    const u = this._config.usage;
    const row = (label, pctId, resetId, span) => {
      const pct = this._num(pctId);
      const reset = this._st(resetId)?.state;
      const left = reset && !DEAD.includes(reset) ? Math.max(0, Date.parse(reset) - Date.now()) : NaN;
      const pace = Number.isNaN(left) ? NaN : ((span - left) / span) * 100;
      const color = Number.isNaN(pct) || Number.isNaN(pace) ? '#94a3b8' : pct - pace > 20 ? '#f87171' : pct - pace < -20 ? '#60a5fa' : '#4ade80';
      const hrs = left / 3600000;
      const when = Number.isNaN(left) ? '—' : hrs >= 24 ? `${Math.floor(hrs / 24)}d ${Math.floor(hrs % 24)}h` : `${Math.floor(hrs)}h ${Math.floor((left % 3600000) / 60000)}m`;
      return `<div class="irow" data-id="${pctId}"><span class="k">${label}</span><span><b>${Number.isNaN(pct) ? '—' : `${Math.round(pct)}%`}</b> <span class="dim">resets ${when}</span></span></div>
        <div class="mb pace"><i style="width:${Number.isNaN(pct) ? 0 : Math.min(pct, 100)}%;background:${color}"></i>${Number.isNaN(pace) ? '' : `<em style="left:${pace}%"></em>`}</div>`;
    };
    return `<section><div class="title"><span>CLAUDE</span></div>
      ${row('5-HOUR', u.session, u.session_reset, 5 * 3600000)}
      ${row('7-DAY', u.week, u.week_reset, 7 * DAY)}
      <div class="note"><span class="dim">Green tracks elapsed time; the tick is where even pace would be.</span></div></section>`;
  }
}

const STYLE = `
:host { display:block; height: calc(100vh - var(--header-height, 56px)); min-height: 640px; font-family: Manrope, system-ui, sans-serif; color:#f1f5f9;
  --card: rgba(30,36,48,.72); --line: rgba(255,255,255,.07); --tile: rgba(255,255,255,.04); --dim:#94a3b8; }
* { box-sizing:border-box; }
ha-icon { --mdc-icon-size: 22px; display:inline-flex; }
#main { height:100%; display:flex; flex-direction:column; gap:14px; padding:14px 20px 18px;
  background: radial-gradient(1200px 500px at 0% 0%, rgba(120,90,30,.35), transparent 60%), radial-gradient(900px 500px at 100% 100%, rgba(20,110,90,.28), transparent 60%), #0d1017; }
header { display:flex; justify-content:space-between; align-items:center; }
h1 { margin:0; font-size:34px; font-weight:800; letter-spacing:-.5px; }
.sub { color:var(--dim); font-size:17px; margin-top:2px; }
.hright { display:flex; gap:12px; align-items:center; }
.pill { display:flex; align-items:center; gap:10px; height:56px; padding:0 20px; border-radius:18px; background:var(--card); border:1px solid var(--line); font-size:18px; font-weight:600; }
.pill b { font-size:22px; } .pill ha-icon { --mdc-icon-size: 28px; }
.dim { color:var(--dim); font-weight:500; } .ok { color:#4ade80; } .warn { color:#fbbf24; } .bad { color:#f87171; } .vio { color:#c4b5fd; }
.dot { width:12px; height:12px; border-radius:50%; background:#22c55e; box-shadow:0 0 10px #22c55e; display:inline-block; } .dot.warn { background:#f59e0b; box-shadow:0 0 10px #f59e0b; }
.clock { font-size:56px; font-weight:800; letter-spacing:-1px; margin-left:8px; line-height:1; } .clock small { font-size:18px; color:var(--dim); margin-left:6px; font-weight:600; }
.grid { flex:1; min-height:0; display:grid; gap:14px; }
section { background:var(--card); border:1px solid var(--line); border-radius:26px; padding:16px 18px; min-height:0; display:flex; flex-direction:column; backdrop-filter: blur(12px); overflow:hidden; position:relative; }
.title { display:flex; align-items:center; gap:10px; color:var(--dim); font-size:15px; font-weight:700; letter-spacing:2px; margin-bottom:10px; }
.title .aside { margin-left:auto; letter-spacing:0; font-weight:600; font-size:15px; color:#cbd5e1; }
[data-id] { cursor:pointer; -webkit-tap-highlight-color:transparent; }

.top { display:flex; align-items:center; gap:16px; }
.ring { width:104px; height:104px; flex:none; border-radius:50%; border:4px solid rgba(148,163,184,.35); display:flex; flex-direction:column; align-items:center; justify-content:center; background:rgba(15,20,30,.6); }
.ring.on { border-color:var(--c); box-shadow:0 0 22px color-mix(in srgb, var(--c) 45%, transparent), inset 0 0 14px color-mix(in srgb, var(--c) 25%, transparent); animation: breathe var(--sp, 3s) ease-in-out infinite; }
@keyframes breathe { 50% { box-shadow:0 0 36px color-mix(in srgb, var(--c) 70%, transparent), inset 0 0 18px color-mix(in srgb, var(--c) 35%, transparent); } }
.ring .v { font-size:30px; font-weight:800; line-height:1; } .ring small { font-size:12px; color:var(--dim); font-weight:600; }
.cost b { display:block; font-size:24px; font-weight:800; } .cost span { color:var(--dim); font-size:15px; }
.mt { display:grid; grid-template-columns:52px 1fr 96px; align-items:center; gap:10px; font-size:15px; margin-top:9px; }
.mt .l { color:var(--dim); font-weight:700; font-size:13px; letter-spacing:1px; } .mt .n { text-align:right; font-weight:700; white-space:nowrap; }
.mb { height:10px; border-radius:5px; background:rgba(255,255,255,.08); overflow:hidden; display:flex; } .mb i { display:block; height:100%; }
.mb.pace { position:relative; overflow:visible; margin:6px 0 4px; } .mb.pace em { position:absolute; top:-4px; width:2px; height:18px; background:#f1f5f9; border-radius:1px; }
.hot { margin-top:6px; font-size:13px; font-weight:700; color:#fbbf24; text-align:right; }
.mini { flex:1; min-height:40px; display:flex; flex-direction:column; margin-top:10px; }
.mini .lg { display:flex; gap:12px; font-size:12px; color:#cbd5e1; } .mini .lg i { display:inline-block; width:10px; height:3px; border-radius:2px; margin-right:5px; vertical-align:3px; }
.mini svg { flex:1; width:100%; min-height:0; overflow:visible; } .mini .s { fill:none; stroke-width:2; vector-effect:non-scaling-stroke; }
.note { padding-top:10px; margin-top:8px; border-top:1px solid var(--line); font-size:15px; color:#cbd5e1; line-height:1.45; } .note .dim { font-size:14px; }
.mdl { margin-top:12px; font-size:15px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; } .mdl b { font-size:20px; }
.chip { display:inline-flex; padding:3px 10px; border-radius:9px; font-size:13px; font-weight:700; background:var(--tile); border:1px solid var(--line); color:var(--dim); }
.chip.ok { color:#4ade80; background:rgba(34,197,94,.1); border-color:rgba(34,197,94,.3); }
.flow { display:flex; align-items:center; gap:10px; margin-top:10px; }
.pips { display:flex; gap:5px; } .pips i { width:14px; height:14px; border-radius:4px; background:rgba(255,255,255,.08); } .pips i.on { background:var(--c); box-shadow:0 0 10px var(--c); } .pips i.q { background:#fbbf24; }
.ln { flex:1; height:3px; border-radius:2px; background:rgba(148,163,184,.2); }
.ln.on { background: repeating-linear-gradient(90deg, var(--c) 0 9px, transparent 9px 16px); animation: fh .6s linear infinite; }
@keyframes fh { to { background-position:16px 0 } }
.tps { font-size:30px; font-weight:800; white-space:nowrap; } .tps small { font-size:13px; color:var(--dim); font-weight:600; }
.irow { display:flex; justify-content:space-between; align-items:baseline; gap:8px; font-size:16px; padding:9px 0; border-bottom:1px solid var(--line); }
.irow .k { color:var(--dim); font-weight:700; font-size:13px; letter-spacing:1.5px; } .irow b { font-size:20px; }
section .note:last-child { margin-top:auto; }
.legend { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:4px 14px; font-size:15px; font-weight:600; color:#cbd5e1; margin-top:-6px; }
.legend i { display:inline-block; width:12px; height:12px; border-radius:4px; margin-right:6px; vertical-align:-1px; }
.plot { flex:1; position:relative; margin:14px 0 22px 52px; min-height:0; }
.plot svg { width:100%; height:100%; display:block; overflow:visible; }
.plot .s { stroke-width:2; vector-effect:non-scaling-stroke; } .plot .gl { stroke:rgba(255,255,255,.07); vector-effect:non-scaling-stroke; }
.yl span { position:absolute; left:-52px; transform:translateY(-50%); font-size:12px; color:var(--dim); width:46px; text-align:right; }
.xl span { position:absolute; bottom:-22px; transform:translateX(-50%); font-size:12px; color:var(--dim); }
@media (max-width: 1800px) {
  :host { height:auto; } header { flex-wrap:wrap; gap:12px; }
  .grid { grid-template-columns:repeat(2, 1fr) !important; } .grid > section:first-child, .grid > section:last-child { grid-column:1 / -1; min-height:360px; }
}
`;

if (!customElements.get('edgelit-hosts-card')) {
  customElements.define('edgelit-hosts-card', EdgelitHostsCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'edgelit-hosts-card', name: 'Edgelit hosts', description: 'Host power, load and inference for a control-panel tab.' });
}
