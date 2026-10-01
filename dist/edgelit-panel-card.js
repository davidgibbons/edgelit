// The whole control-panel screen as one Lovelace card: header, energy flow,
// quick actions, rooms, weather, calendar, charger and music, drawn from live
// hass state. Plain HTMLElement, no build step: HA loads this file as a module
// resource. Configuration lives in the dashboard (see README.md).

const FONT = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cap = (s) => String(s ?? '').replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase());
const DEAD = ['unavailable', 'unknown'];

const WEATHER_ICON = {
  'clear-night': 'weather-night', cloudy: 'weather-cloudy', exceptional: 'alert-circle-outline',
  fog: 'weather-fog', hail: 'weather-hail', lightning: 'weather-lightning',
  'lightning-rainy': 'weather-lightning-rainy', partlycloudy: 'weather-partly-cloudy',
  pouring: 'weather-pouring', rainy: 'weather-rainy', snowy: 'weather-snowy',
  'snowy-rainy': 'weather-snowy-rainy', sunny: 'weather-sunny', windy: 'weather-windy',
  'windy-variant': 'weather-windy-variant',
};
const WEATHER_COLOR = { sunny: '#fbbf24', 'clear-night': '#a5b4fc', partlycloudy: '#fcd34d', rainy: '#60a5fa', pouring: '#3b82f6', lightning: '#facc15', 'lightning-rainy': '#facc15' };

const ACCENT = { climate: '#38bdf8', lights: '#fbbf24', light: '#fbbf24', switch: '#34d399', fan: '#34d399', script: '#a78bfa', vacuum: '#2dd4bf', alarm_control_panel: '#f87171', water_heater: '#f97316', reload: '#94a3b8' };

class EdgelitPanelCard extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._tab = 0;
    this._forecast = [];
    this._events = [];
    this._popup = false;
    this._stats = null;
    this._seen = new Map();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._init();
    if (this._changed()) this._render();
  }

  connectedCallback() {
    if (this._hass && !this._clock) this._init();
  }

  disconnectedCallback() {
    clearInterval(this._clock);
    clearInterval(this._calTimer);
    this._clock = this._calTimer = null;
    this._unsubForecast?.then((u) => u()).catch(() => {});
    this._unsubForecast = null;
  }

  getCardSize() { return 12; }

  _init() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' }).innerHTML = `<style>${STYLE}</style><div id="main"></div><div id="pop"></div>`;
      this.shadowRoot.addEventListener('click', (e) => this._click(e));
      if (!document.querySelector(`link[href="${FONT}"]`)) {
        document.head.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="${FONT}">`);
      }
    }
    if (this._clock) return;
    this._clock = setInterval(() => this._render(), 15000);
    this._subscribeForecast();
    this._loadEvents();
    this._calTimer = setInterval(() => this._loadEvents(), 15 * 60000);
  }

  // ---- data ---------------------------------------------------------------

  _watched() {
    const c = this._config;
    const ids = [...Object.values(c.energy || {}).filter((v) => typeof v === 'string'), c.weather, 'sun.sun', ...(c.people || []), ...(c.media || []), ...Object.values(c.charger || {})];
    for (const a of c.actions || []) ids.push(a.entity, ...(a.entities || []));
    for (const r of c.rooms || []) ids.push(r.temp, ...(r.lights || []));
    return ids.filter(Boolean);
  }

  // HA swaps a state object whenever the entity changes, so identity is enough.
  _changed() {
    let changed = false;
    for (const id of this._watched()) {
      const s = this._hass.states[id];
      if (this._seen.get(id) !== s) { this._seen.set(id, s); changed = true; }
    }
    return changed;
  }

  _st(id) { return id ? this._hass.states[id] : undefined; }
  _ok(id) { const s = this._st(id); return !!s && !DEAD.includes(s.state); }
  _num(id) { const s = this._st(id); return s ? parseFloat(s.state) : NaN; }
  _w(id) {
    const s = this._st(id);
    const v = s ? parseFloat(s.state) : NaN;
    if (Number.isNaN(v)) return 0;
    return s.attributes.unit_of_measurement === 'kW' ? v * 1000 : v;
  }
  _fmt(s) { return s ? (this._hass.formatEntityState?.(s) ?? cap(s.state)) : '—'; }

  // Where today's home use came from. Grid import also covers battery
  // charging, so it can exceed home use: take solar first, then the battery,
  // and call the rest grid.
  _mix() {
    const e = this._config.energy;
    const v = (id) => { const n = this._num(id); return Number.isNaN(n) ? 0 : n; };
    const used = v(e.home_today);
    const fromSolar = Math.min(v(e.solar_today), used);
    const fromBatt = Math.min(v(e.discharge_today), used - fromSolar);
    const fromGrid = used - fromSolar - fromBatt;
    return { used, fromSolar, fromBatt, fromGrid, self: used > 0 ? Math.round(((fromSolar + fromBatt) / used) * 100) : null };
  }

  // The tariff sensor lists every tier in all_rates and its state is the one
  // in effect now. `price`, when set, is what that tier actually costs.
  _rate() {
    const e = this._config.energy || {};
    const s = this._st(e.rate);
    const r = s ? parseFloat(s.state) : NaN;
    if (Number.isNaN(r)) return null;
    const tiers = [...(s.attributes.all_rates || [r])].sort((a, b) => a - b);
    const tier = tiers.length < 2 ? '' : r <= tiers[0] ? 'Off-peak' : r >= tiers.at(-1) ? 'Peak' : 'Mid-peak';
    const v = e.price ? this._num(e.price) : r;
    return Number.isNaN(v) ? null : { v, tier };
  }

  // What the battery saved today: its output priced at the rate when it
  // discharged, minus its charging priced at the rate when it charged.
  _battSaved() {
    const e = this._config.energy;
    const pts = this._stats?.[e.battery];
    const rates = this._rates;
    if (!pts?.length || !rates?.length) return null;
    const unit = this._st(e.battery)?.attributes.unit_of_measurement;
    let saved = 0;
    let r = 0;
    for (const p of pts) {
      const ts = typeof p.start === 'number' ? p.start : Date.parse(p.start);
      if (ts < rates[0][0]) continue; // before the price sensor had a value
      while (r + 1 < rates.length && rates[r + 1][0] <= ts) r++;
      const kwh = ((unit === 'kW' ? p.mean : p.mean / 1000) * 5) / 60; // positive while charging
      saved -= kwh * rates[r][1];
    }
    return saved;
  }

  _subscribeForecast() {
    const id = this._config.weather;
    if (!id || !this._hass.connection) return;
    this._unsubForecast = this._hass.connection.subscribeMessage(
      (msg) => { this._forecast = msg.forecast || []; this._render(); },
      { type: 'weather/subscribe_forecast', entity_id: id, forecast_type: 'daily' },
    );
    this._unsubForecast.catch(() => {});
  }

  async _loadEvents() {
    const cals = this._config.calendars || [];
    if (!cals.length) return;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 14 * 86400000);
    const q = `start=${start.toISOString()}&end=${end.toISOString()}`;
    const lists = await Promise.all(cals.map((c) => this._hass.callApi('GET', `calendars/${c}?${q}`).catch(() => [])));
    const now = Date.now();
    this._events = lists.flat()
      .map((e) => {
        const allDay = !!e.start.date;
        // Date-only values are local days; Date.parse would read them as UTC.
        const s = allDay ? new Date(`${e.start.date}T00:00`) : new Date(e.start.dateTime);
        const en = allDay ? new Date(`${e.end.date}T00:00`) : new Date(e.end.dateTime);
        return { title: e.summary, start: s, end: en, allDay };
      })
      .filter((e) => e.end.getTime() > now)
      .sort((a, b) => a.start - b.start);
    this._render();
  }

  async _loadStats() {
    const e = this._config.energy;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const ids = [e.solar, e.home, e.grid_import, e.grid_export, e.battery, e.battery_soc].filter(Boolean);
    const priceId = e.price || e.rate;
    if (priceId) {
      const hist = await this._hass.callWS({
        type: 'history/history_during_period', start_time: start.toISOString(),
        entity_ids: [priceId], minimal_response: true, no_attributes: true,
      }).catch(() => ({}));
      // Minimal responses give lu in epoch seconds; the first row is the state at start_time.
      this._rates = (hist[priceId] || []).map((h) => [h.lu * 1000, parseFloat(h.s)]).filter(([, v]) => !Number.isNaN(v));
    }
    try {
      this._stats = await this._hass.callWS({
        type: 'recorder/statistics_during_period',
        start_time: start.toISOString(), end_time: new Date().toISOString(),
        statistic_ids: ids, period: '5minute', types: ['mean'],
      });
    } catch (err) {
      this._stats = { error: String(err.message || err) };
    }
    this._renderPopup();
  }

  // ---- actions ------------------------------------------------------------

  _click(ev) {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    ev.stopPropagation();
    const { act, id, i, cmd } = el.dataset;
    const call = (d, s, data) => this._hass.callService(d, s, data);
    if (act === 'more-info') {
      this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId: id }, bubbles: true, composed: true }));
    } else if (act === 'room') {
      const lights = this._config.rooms[i].lights;
      const on = lights.some((l) => this._st(l)?.state === 'on');
      call('light', on ? 'turn_off' : 'turn_on', { entity_id: lights });
    } else if (act === 'action') {
      this._runAction(this._config.actions[i]);
    } else if (act === 'tab') {
      this._tab = +i; this._render();
    } else if (act === 'energy') {
      this._popup = true; this._renderPopup(); this._loadStats();
      clearInterval(this._statTimer);
      this._statTimer = setInterval(() => this._loadStats(), 5 * 60000);
    } else if (act === 'close') {
      this._popup = false; clearInterval(this._statTimer); this._renderPopup();
    } else if (act === 'media') {
      call('media_player', cmd, { entity_id: id });
    } else if (act === 'toggle') {
      call('homeassistant', 'toggle', { entity_id: id });
    }
  }

  _runAction(a) {
    const call = (d, s, data) => this._hass.callService(d, s, data);
    const tap = a.tap || this._defaultTap(a);
    if (tap === 'reload') return location.reload();
    if (tap === 'lights-off') {
      const on = a.entities.filter((l) => this._st(l)?.state === 'on');
      if (on.length) call('light', 'turn_off', { entity_id: on });
      return;
    }
    if (tap === 'toggle') return call('homeassistant', 'toggle', { entity_id: a.entity });
    if (tap === 'run') return call('script', 'turn_on', { entity_id: a.entity });
    this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId: a.entity }, bubbles: true, composed: true }));
  }

  _defaultTap(a) {
    if (a.type === 'lights') return 'lights-off';
    if (a.type === 'reload') return 'reload';
    const d = a.entity?.split('.')[0];
    if (['switch', 'input_boolean', 'fan', 'light'].includes(d)) return 'toggle';
    if (d === 'script') return 'run';
    return 'more-info';
  }

  // ---- render -------------------------------------------------------------

  _render() {
    if (!this.shadowRoot || !this._hass) return;
    this.shadowRoot.getElementById('main').innerHTML = `
      ${this._header()}
      <div class="grid">
        ${this._energy()}
        ${this._actions()}
        ${this._rooms()}
        <div class="col">${this._weather()}${this._calendar()}</div>
        <div class="col">${this._charger()}${this._music()}</div>
      </div>`;
    if (this._popup) this._renderPopup();
  }

  _header() {
    const now = new Date();
    const h = now.getHours();
    const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name = this._config.name || this._hass.user?.name || '';
    const date = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    const [time, ampm] = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).split(' ');

    const people = (this._config.people || []).map((p) => {
      const s = this._st(p);
      if (!s) return '';
      const home = s.state === 'home';
      const nm = s.attributes.friendly_name || p;
      const pic = s.attributes.entity_picture;
      return `<div class="av ${home ? '' : 'away'}" title="${esc(nm)}" data-act="more-info" data-id="${p}">${pic ? `<img src="${esc(pic)}">` : esc(nm[0])}</div>`;
    }).join('');

    const w = this._st(this._config.weather);
    const weather = w ? `<div class="pill" data-act="more-info" data-id="${w.entity_id}">
        <ha-icon icon="mdi:${WEATHER_ICON[w.state] || 'weather-cloudy'}" style="color:${WEATHER_COLOR[w.state] || '#cbd5e1'}"></ha-icon>
        <b>${Math.round(w.attributes.temperature)}°</b><span class="dim">${esc(this._fmt(w))}</span></div>` : '';

    const dead = [...new Set(this._watched())].filter((id) => !this._ok(id) && this._st(id));
    const status = dead.length
      ? `<div class="pill" title="${esc(dead.join('\n'))}"><i class="dot warn"></i>${dead.length} offline</div>`
      : `<div class="pill"><i class="dot"></i>All systems normal</div>`;

    return `<header>
      <div><h1>${greet}${name ? `, ${esc(name)}` : ''}</h1><div class="sub">${esc(date)}</div></div>
      <div class="hright">
        ${people ? `<div class="pill people">${people}</div>` : ''}
        ${weather}${status}
        <div class="clock">${esc(time)}${ampm ? `<small>${esc(ampm)}</small>` : ''}</div>
      </div></header>`;
  }

  _energy() {
    const e = this._config.energy;
    if (!e) return '<section></section>';
    const solar = this._w(e.solar);
    const home = this._w(e.home);
    const grid = this._w(e.grid_import) - this._w(e.grid_export);
    const batt = this._w(e.battery); // positive while charging
    const soc = this._num(e.battery_soc);
    const ev = this._w(e.ev);
    const evSoc = this._num(e.ev_soc);
    const kw = (w) => Math.abs(w) >= 1000 ? [(w / 1000).toFixed(1), 'kW'] : [Math.round(w), 'W'];
    const on = (w) => Math.abs(w) > 20;

    const node = (cls, icon, big, unit, label, status, color, active, act) => `
      <div class="nd ${cls}">
        <div class="ring ${active ? 'on' : ''}" style="--c:${color}" ${act || ''}>
          <ha-icon icon="${icon}"></ha-icon><div class="v">${big}<small>${unit}</small></div>
          ${cls === 'home' ? '<div class="lbl">HOME</div>' : ''}
        </div>
        ${cls === 'home' ? '' : `<div class="cap"><span>${label}</span><b style="${active ? `color:${color}` : ''}">${status}</b></div>`}
      </div>`;
    const line = (dir, active, color, rev) => `<div class="ln ${dir} ${active ? 'on' : ''} ${rev ? 'rev' : ''}" style="--c:${color}"></div>`;

    const [sv, su] = kw(solar);
    const [gv, gu] = kw(Math.abs(grid));
    const [hv, hu] = kw(home);
    const battStatus = on(batt) ? `${batt > 0 ? 'Charging' : 'Discharging'} ${kw(Math.abs(batt)).join(' ')}` : 'Idle';
    const evStatus = on(ev) ? `Charging ${kw(ev).join(' ')}` : this._fmt(this._st(e.ev_state)) || 'Idle';

    const t = (id) => this._num(id);
    const used = t(e.home_today);
    const imp = t(e.import_today);
    const { self } = this._mix();
    const rate = this._rate();
    const cost = this._num(e.cost_today);
    const stat = (label, v, sub) => `<div class="stat"><span>${label}</span><b>${Number.isNaN(v) ? '—' : v.toFixed(1)}<small>kWh</small></b>${sub ? `<em>${sub}</em>` : ''}</div>`;

    return `<section class="energy" data-act="energy">
      <div class="title"><span>HOME ENERGY</span><span class="aside">${rate ? `<b class="tier ${rate.tier === 'Peak' ? 'peak' : rate.tier === 'Mid-peak' ? 'mid' : ''}">${rate.tier} $${rate.v.toFixed(2)}</b>` : ''}${self === null ? '' : `${rate ? ' · ' : ''}${self}% self-powered`}</span><span class="chev">›</span></div>
      <div class="flow ${e.solar ? '' : 'nosolar'}">
        ${e.solar ? `<div></div><div></div>${node('solar', 'mdi:white-balance-sunny', sv, su, 'SOLAR', on(solar) ? 'Producing' : 'Idle', '#fbbf24', on(solar))}<div></div><div></div>
        <div></div><div></div>${line('v', on(solar), '#fbbf24')}<div></div><div></div>` : ''}
        ${node('gridn', 'mdi:transmission-tower', gv, gu, 'GRID', on(grid) ? (grid > 0 ? 'Importing' : 'Exporting') : 'Idle', '#94a3b8', on(grid))}
        ${line('h', on(grid), '#94a3b8', grid < 0)}
        ${node('home', 'mdi:home-outline', hv, hu, '', '', '#38bdf8', true)}
        ${line('h', on(batt), '#34d399', batt < 0)}
        ${node('batt', 'mdi:battery-charging-medium', Number.isNaN(soc) ? '—' : Math.round(soc), '%', 'BATTERY', battStatus, '#34d399', on(batt))}
        <div></div><div></div>${line('v', on(ev), '#a78bfa')}<div></div><div></div>
        <div></div><div></div>${node('ev', 'mdi:car-electric-outline', Number.isNaN(evSoc) ? kw(ev)[0] : Math.round(evSoc), Number.isNaN(evSoc) ? kw(ev)[1] : '%', 'EV', evStatus, '#a78bfa', on(ev))}<div></div><div></div>
      </div>
      <div class="stats">
        ${e.solar_today ? stat('SOLAR', t(e.solar_today)) : ''}
        ${stat('USED', used)}
        ${stat('GRID IN', imp, Number.isNaN(cost) ? '' : `$${cost.toFixed(2)}`)}
        ${stat('EXPORT', t(e.export_today))}
      </div>
    </section>`;
  }

  _actionModel(a) {
    const s = this._st(a.entity);
    const d = a.type === 'lights' ? 'lights' : a.type === 'reload' ? 'reload' : a.entity?.split('.')[0];
    let status = this._fmt(s);
    let active = false;
    let icon = a.icon || s?.attributes.icon;
    if (d === 'lights') {
      const n = a.entities.filter((l) => this._st(l)?.state === 'on').length;
      status = n ? `${n} on` : 'All off'; active = n > 0; icon ||= 'mdi:lightbulb-group';
    } else if (d === 'reload') {
      status = 'Reload panel'; icon ||= 'mdi:refresh';
    } else if (d === 'climate' && s) {
      const cur = s.attributes.current_temperature;
      const act = s.attributes.hvac_action;
      status = `${act && act !== 'idle' && act !== 'off' ? cap(act) : this._fmt(s)}${cur != null ? ` · ${Math.round(cur)}°` : ''}`;
      active = s.state !== 'off' && !DEAD.includes(s.state); icon ||= 'mdi:thermostat';
    } else if (d === 'script' && s) {
      active = s.state === 'on'; status = active ? 'Running' : 'Tap to run'; icon ||= 'mdi:script-text-outline';
    } else if (d === 'vacuum' && s) {
      active = !['docked', 'idle', 'off', ...DEAD].includes(s.state); icon ||= 'mdi:robot-vacuum';
    } else if (d === 'alarm_control_panel' && s) {
      active = s.state !== 'disarmed' && !DEAD.includes(s.state); icon ||= 'mdi:shield-home-outline';
    } else if (s) {
      active = s.state === 'on'; icon ||= 'mdi:toggle-switch-outline';
    }
    return { name: a.name || s?.attributes.friendly_name || a.entity, status, active, icon, color: a.color || ACCENT[d] || '#38bdf8' };
  }

  _actions() {
    const tiles = (this._config.actions || []).map((a, i) => {
      const m = this._actionModel(a);
      return `<div class="tile ${m.active ? 'on' : ''}" style="--c:${m.color}" data-act="action" data-i="${i}">
        <div class="ic"><ha-icon icon="${esc(m.icon)}"></ha-icon></div>
        <div><b>${esc(m.name)}</b><span>${esc(m.status)}</span></div></div>`;
    }).join('');
    return `<section><div class="title"><span>QUICK ACTIONS</span></div><div class="tiles">${tiles}</div></section>`;
  }

  _rooms() {
    const rooms = this._config.rooms || [];
    const groups = [...new Set(rooms.map((r) => r.group || 'Rooms'))];
    const tab = Math.min(this._tab, groups.length - 1);
    const lit = (r) => r.lights.filter((l) => this._st(l)?.state === 'on').length;
    const litRooms = rooms.filter((r) => lit(r) > 0).length;
    const tabs = groups.length > 1 ? `<div class="tabs">${groups.map((g, i) => {
      const n = rooms.filter((r) => (r.group || 'Rooms') === g && lit(r) > 0).length;
      return `<div class="tab ${i === tab ? 'sel' : ''}" data-act="tab" data-i="${i}">${esc(g)}${n ? `<i>${n}</i>` : ''}</div>`;
    }).join('')}</div>` : '';
    const cards = rooms.map((r, i) => ({ r, i })).filter(({ r }) => (r.group || 'Rooms') === groups[tab]).map(({ r, i }) => {
      const n = lit(r);
      const temp = this._ok(r.temp) ? `${Math.round(this._num(r.temp))}° · ` : '';
      const dead = r.lights.every((l) => !this._ok(l));
      const sub = dead ? 'Unavailable' : n ? `${temp}${r.lights.length > 1 ? `${n} light${n > 1 ? 's' : ''}` : 'On'}` : `${temp}Off`;
      return `<div class="room ${n ? 'on' : ''}" data-act="more-info" data-id="${r.lights[0]}">
        <div class="ic"><ha-icon icon="${esc(r.icon || 'mdi:lightbulb-outline')}"></ha-icon></div>
        <div class="nm"><b>${esc(r.name)}</b><span>${esc(sub)}</span></div>
        <div class="bulb" data-act="room" data-i="${i}"><ha-icon icon="mdi:lightbulb${n ? '' : '-outline'}"></ha-icon></div></div>`;
    }).join('');
    return `<section><div class="title"><span>ROOMS</span><span class="aside">${litRooms ? `${litRooms} lit` : 'All dark'}</span></div>${tabs}<div class="rooms">${cards}</div></section>`;
  }

  _weather() {
    const w = this._st(this._config.weather);
    if (!w) return '';
    const a = w.attributes;
    const today = this._forecast[0];
    const sun = this._st('sun.sun');
    const t = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const sunPill = sun ? (sun.state === 'above_horizon' ? `Sunset ${t(sun.attributes.next_setting)}` : `Sunrise ${t(sun.attributes.next_rising)}`) : '';
    const days = this._forecast.slice(0, 5).map((f, i) => {
      const d = i === 0 ? 'Today' : new Date(f.datetime).toLocaleDateString([], { weekday: 'short' });
      const p = f.precipitation ? `<em>${f.precipitation}${a.precipitation_unit || ''}</em>` : '';
      return `<div class="day"><span>${d}</span><ha-icon icon="mdi:${WEATHER_ICON[f.condition] || 'weather-cloudy'}" style="color:${WEATHER_COLOR[f.condition] || '#cbd5e1'}"></ha-icon><b>${Math.round(f.temperature)}°</b><small>${f.templow != null ? `${Math.round(f.templow)}°` : ''}</small>${p}</div>`;
    }).join('');
    return `<section class="weather" data-act="more-info" data-id="${w.entity_id}">
      <div class="title"><span>WEATHER</span><span class="aside">${a.humidity ?? '—'}% humidity · wind ${Math.round(a.wind_speed ?? 0)} ${esc(a.wind_speed_unit || '')}</span></div>
      <div class="now">
        <ha-icon icon="mdi:${WEATHER_ICON[w.state] || 'weather-cloudy'}" style="color:${WEATHER_COLOR[w.state] || '#cbd5e1'}"></ha-icon>
        <div><div class="big">${Math.round(a.temperature)}<sup>°</sup></div><b>${esc(this._fmt(w))}</b>
        <span>${today ? `High ${Math.round(today.temperature)}° · Low ${Math.round(today.templow ?? today.temperature)}°` : ''}</span></div>
        ${sunPill ? `<div class="chip">${sunPill}</div>` : ''}
      </div>
      <div class="days">${days}</div></section>`;
  }

  _calendar() {
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const dayIdx = (d) => Math.floor((new Date(d).setHours(0, 0, 0, 0) - day0) / 86400000);
    const todayN = this._events.filter((e) => dayIdx(e.start) <= 0).length;
    const rows = this._events.slice(0, 3).map((e) => {
      const di = dayIdx(e.start);
      const when = di <= 0 ? 'Today' : di === 1 ? 'Tomorrow' : e.start.toLocaleDateString([], { weekday: 'short' });
      const time = e.allDay ? 'All day' : e.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return `<div class="ev ${di <= 0 ? 'today' : ''}"><div class="date"><b>${e.start.getDate()}</b><span>${e.start.toLocaleDateString([], { month: 'short' }).toUpperCase()}</span></div>
        <div><b>${esc(e.title)}</b><span>${when} · ${time}</span></div></div>`;
    }).join('') || '<div class="empty">Nothing in the next two weeks</div>';
    return `<section class="cal"><div class="title"><span>CALENDAR</span><span class="aside hot">${todayN ? `${todayN} today` : ''}</span></div>${rows}</section>`;
  }

  _charger() {
    const c = this._config.charger;
    if (!c) return '';
    const kw = this._w(c.power) / 1000;
    const charging = kw > 0.05;
    const cable = this._st(c.cable);
    const plugged = cable && !/unplug/i.test(cable.state) && !DEAD.includes(cable.state);
    const energy = this._num(c.energy);
    const miles = this._num(c.miles);
    const sched = this._st(c.schedule);
    const hm = (id) => { const s = this._st(id); if (!s || DEAD.includes(s.state)) return ''; const [h, m] = s.state.split(':'); return new Date(2000, 0, 1, +h, +m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
    const window = hm(c.schedule_start) && hm(c.schedule_end) ? ` ${hm(c.schedule_start)}–${hm(c.schedule_end)}` : '';
    return `<section class="charger" data-act="more-info" data-id="${c.state || c.power}">
      <div class="title"><span>${esc(c.name || 'CHARGER')}</span><span class="aside">${esc(this._fmt(this._st(c.state)))}</span></div>
      <div class="chg">
        <div><div class="big">${charging ? kw.toFixed(1) : Number.isNaN(energy) ? '—' : energy.toFixed(1)}<sup>${charging ? 'kW' : 'kWh'}</sup></div>
        <span>${charging ? 'Charging now' : 'Last session'}${Number.isNaN(miles) ? '' : ` · +${Math.round(miles)} mi`}</span></div>
        <ha-icon icon="mdi:ev-station" class="car ${charging ? 'on' : ''}"></ha-icon>
      </div>
      <div class="bar"><i style="width:${charging ? 100 : plugged ? 35 : 0}%" class="${charging ? 'pulse' : ''}"></i></div>
      <div class="chips">
        <div class="chip ${plugged ? 'good' : ''}"><ha-icon icon="mdi:ev-plug-type1"></ha-icon>${plugged ? 'Plugged in' : 'Unplugged'}</div>
        ${sched ? `<div class="chip ${sched.state === 'on' ? 'good' : ''}" data-act="toggle" data-id="${sched.entity_id}"><ha-icon icon="mdi:calendar-clock"></ha-icon>${sched.state === 'on' ? `Scheduled${window}` : 'Schedule off'}</div>` : ''}
      </div></section>`;
  }

  _music() {
    const list = this._config.media || [];
    if (!list.length) return '';
    const id = list.find((m) => this._st(m)?.state === 'playing') || list.find((m) => this._ok(m)) || list[0];
    const s = this._st(id);
    const a = s?.attributes || {};
    const playing = s?.state === 'playing';
    const active = ['playing', 'paused'].includes(s?.state);
    const art = a.entity_picture_local || a.entity_picture;
    const title = active ? (a.media_title || a.app_name || 'Playing') : 'Nothing playing';
    const sub = active ? (a.media_artist || a.media_album_name || a.app_name || '') : 'Start something from a speaker';
    return `<section class="music">
      <div class="title"><span>MUSIC</span></div>
      <div class="mus">
        <div class="disc ${playing ? 'spin' : ''}" data-act="more-info" data-id="${id}">
          <div class="label" ${art ? `style="background-image:url('${esc(art)}')"` : ''}>${art ? '' : '<ha-icon icon="mdi:music-note"></ha-icon>'}</div></div>
        <div class="meta">
          <b>${esc(title)}</b><span>${esc(sub)}</span>
          <div class="chip violet" data-act="more-info" data-id="${id}"><ha-icon icon="mdi:speaker"></ha-icon>${esc(a.friendly_name || id)}</div>
          <div class="ctl">
            <div data-act="media" data-cmd="media_previous_track" data-id="${id}"><ha-icon icon="mdi:skip-previous"></ha-icon></div>
            <div class="play" data-act="media" data-cmd="media_play_pause" data-id="${id}"><ha-icon icon="mdi:${playing ? 'pause' : 'play'}"></ha-icon></div>
            <div data-act="media" data-cmd="media_next_track" data-id="${id}"><ha-icon icon="mdi:skip-next"></ha-icon></div>
          </div>
        </div>
      </div></section>`;
  }

  // ---- energy popup -------------------------------------------------------

  _renderPopup() {
    const pop = this.shadowRoot?.getElementById('pop');
    if (!pop) return;
    if (!this._popup) { pop.innerHTML = ''; return; }
    const e = this._config.energy;
    const t = (id) => this._num(id);
    const solar = this._w(e.solar);
    const home = this._w(e.home);
    const batt = this._w(e.battery);
    const runner = e.solar && solar >= home * 0.8 ? 'Solar is running the house' : batt < -20 ? 'The battery is running the house' : 'The grid is running the house';
    const kw = (w) => Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`;

    const used = t(e.home_today);
    const imp = t(e.import_today);
    const dis = t(e.discharge_today);
    const chg = t(e.charge_today);
    const solarToday = t(e.solar_today);
    const rate = this._rate();
    const cost = this._num(e.cost_today);
    const saved = this._battSaved();
    const { fromSolar, fromBatt, fromGrid, self } = this._mix();
    const total = fromSolar + fromBatt + fromGrid || 1;
    const pct = (v) => Math.round((v / total) * 100);
    const C = 2 * Math.PI * 70;
    let off = 0;
    const arc = (v, color) => { const len = (v / total) * C; const s = `<circle r="70" cx="90" cy="90" fill="none" stroke="${color}" stroke-width="22" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}"/>`; off += len; return s; };
    const n = (v, d = 1) => (Number.isNaN(v) ? '—' : v.toFixed(d));
    const money = (v) => `$${v.toFixed(2)}`;

    pop.innerHTML = `<div class="pop"><div class="sheet">
      <div class="phead">
        <div class="pic"><ha-icon icon="mdi:lightning-bolt"></ha-icon></div>
        <div><h2>Home energy</h2><div class="sub"><i class="dot"></i><b>${runner}</b> · Home ${kw(home)}${e.solar ? ` · Solar ${kw(solar)}` : ''} · Battery ${Math.round(t(e.battery_soc))}%</div></div>
        <div class="x" data-act="close"><ha-icon icon="mdi:close"></ha-icon></div>
      </div>
      <div class="pbody"><div class="pcard chart">${this._chart()}</div>
      <div class="prow">
        <div class="pcard">
          <h3>Where your power came from</h3><div class="sub">Of the ${n(used)} kWh the house used today</div>
          <div class="donut">
            <svg viewBox="0 0 180 180"><g transform="rotate(-90 90 90)">${arc(fromSolar, '#fbbf24')}${arc(fromBatt, '#34d399')}${arc(fromGrid, '#94a3b8')}</g>
              <text x="90" y="92" class="dp">${self ?? 0}%</text><text x="90" y="116" class="dl">self-powered</text></svg>
            <div class="legend">
              ${e.solar_today ? `<div><i style="background:#fbbf24"></i>Straight from solar<b>${n(fromSolar)} kWh</b><span>${pct(fromSolar)}%</span></div>` : ''}
              <div><i style="background:#34d399"></i>From the battery<b>${n(fromBatt)} kWh</b><span>${pct(fromBatt)}%</span></div>
              <div><i style="background:#94a3b8"></i>Bought from the grid<b>${n(fromGrid)} kWh</b><span>${pct(fromGrid)}%</span></div>
            </div>
          </div>
        </div>
        <div class="pcard">
          <h3>Today's totals</h3><div class="sub">${rate ? `Priced at the time-of-day rate · now ${rate.tier.toLowerCase()} $${rate.v.toFixed(3)}/kWh` : 'Set energy.rate for costs'}</div>
          <div class="totals">
            ${e.solar_today ? `<div class="stat"><span>SOLAR MADE</span><b class="y">${n(solarToday)}<small>kWh</small></b><em>${t(e.export_today) > 0 ? `${n(t(e.export_today))} kWh exported` : 'Nothing exported'}</em></div>` : ''}
            <div class="stat"><span>HOME USED</span><b>${n(used)}<small>kWh</small></b></div>
            <div class="stat"><span>BOUGHT</span><b>${n(imp)}<small>kWh</small></b><em>${Number.isNaN(cost) ? '' : money(cost)}</em></div>
            <div class="stat"><span>BATTERY</span><b>${n(chg)}<small>kWh in</small></b><em>${n(dis)} kWh out</em></div>
            ${saved === null ? '' : `<div class="stat ${saved >= 0 ? 'good' : ''}"><span>BATTERY SAVED</span><b class="${saved >= 0 ? 'g' : ''}">${saved < 0 ? '−' : ''}${money(Math.abs(saved))}</b><em>output at its rate, less charging</em></div>`}
          </div>
        </div>
      </div></div></div></div>`;
  }

  _chart() {
    const e = this._config.energy;
    const head = (sub) => `<h3>Today, hour by hour</h3><div class="sub">${sub}</div>`;
    if (!this._stats) return `${head('Loading…')}<div class="plot"></div>`;
    if (this._stats.error) return `${head(`Couldn't load history: ${esc(this._stats.error)}`)}<div class="plot"></div>`;
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const series = (id, f = (v) => v) => (this._stats[id] || []).map((p) => {
      const ts = typeof p.start === 'number' ? p.start : Date.parse(p.start);
      const unit = this._st(id)?.attributes.unit_of_measurement;
      return [ts, f(unit === 'kW' ? p.mean : p.mean / 1000)];
    }).filter(([, v]) => v != null && !Number.isNaN(v));
    const solar = series(e.solar);
    const home = series(e.home);
    const imp = series(e.grid_import);
    const exp = new Map(series(e.grid_export));
    const grid = imp.map(([ts, v]) => [ts, v - (exp.get(ts) || 0)]);
    const batt = series(e.battery, (v) => -v); // positive while the battery is supplying
    const soc = (this._stats[e.battery_soc] || []).map((p) => [typeof p.start === 'number' ? p.start : Date.parse(p.start), p.mean]);

    const all = [...solar, ...home, ...grid, ...batt].map(([, v]) => Math.abs(v));
    const max = Math.max(2, Math.ceil(Math.max(0, ...all)));
    const W = 1000, H = 300;
    const x = (ts) => ((ts - day0) / 86400000) * W;
    const y = (v) => H / 2 - (v / max) * (H / 2 - 6);
    const ys = (p) => H - 6 - (p / 100) * (H - 12);
    const path = (pts, fy = y) => pts.map(([ts, v], i) => `${i ? 'L' : 'M'}${x(ts).toFixed(1)},${fy(v).toFixed(1)}`).join('');
    const area = (pts) => pts.length ? `${path(pts)}L${x(pts.at(-1)[0]).toFixed(1)},${y(0)}L${x(pts[0][0]).toFixed(1)},${y(0)}Z` : '';
    const nowX = x(Date.now());

    const [src, label] = e.solar ? [solar, 'Solar'] : [home, 'Home use'];
    let peak = [0, 0];
    for (const p of src) if (p[1] > peak[1]) peak = p;
    const sub = peak[1] > 0.05
      ? `${label} peaked at ${peak[1].toFixed(1)} kW around ${new Date(peak[0]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : `No ${label.toLowerCase()} yet today`;
    const ticks = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => `<span style="left:${(h / 24) * 100}%">${h === 24 ? '' : new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}</span>`).join('');
    const yl = [max, max / 2, 0, -max / 2, -max].map((v, i) => `<span style="top:${i * 25}%">${Math.round(v * 10) / 10}${i === 0 ? ' kW' : ''}</span>`).join('');

    return `${head(sub)}
      <div class="legend2">${e.solar ? '<span><i style="background:#fbbf24"></i>Solar</span>' : ''}<span><i style="background:#38bdf8"></i>Home</span><span><i style="background:#94a3b8"></i>Grid</span><span><i style="background:#34d399"></i>Battery</span><span><i class="dash"></i>Charge %</span></div>
      <div class="plot">
        <div class="yl">${yl}</div>
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          ${[0, 1, 2, 3, 4].map((i) => `<line x1="0" x2="${W}" y1="${(i * H) / 4}" y2="${(i * H) / 4}" class="gl"/>`).join('')}
          <path d="${area(grid)}" fill="rgba(148,163,184,.25)" stroke="#94a3b8" class="s"/>
          <path d="${area(solar)}" fill="rgba(251,191,36,.28)" stroke="#fbbf24" class="s"/>
          <path d="${path(batt)}" fill="none" stroke="#34d399" class="s"/>
          <path d="${path(home)}" fill="none" stroke="#38bdf8" class="s"/>
          <path d="${path(soc, ys)}" fill="none" stroke="#a78bfa" class="s dash"/>
          <line x1="${nowX}" x2="${nowX}" y1="0" y2="${H}" class="now"/>
        </svg>
        <div class="xl">${ticks}</div>
      </div>`;
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
.pill b { font-size:22px; } .dim { color:var(--dim); font-weight:500; }
.pill ha-icon { --mdc-icon-size: 28px; }
.people { padding:0 10px; gap:0; }
.av { width:38px; height:38px; border-radius:50%; margin-left:-8px; border:2px solid #0d1017; background:#334155; display:grid; place-items:center; font-weight:700; overflow:hidden; }
.av:first-child { margin-left:0; } .av img { width:100%; height:100%; object-fit:cover; } .av.away { opacity:.35; filter:grayscale(1); }
.dot { width:12px; height:12px; border-radius:50%; background:#22c55e; box-shadow:0 0 10px #22c55e; display:inline-block; } .dot.warn { background:#f59e0b; box-shadow:0 0 10px #f59e0b; }
.clock { font-size:56px; font-weight:800; letter-spacing:-1px; margin-left:8px; line-height:1; } .clock small { font-size:18px; color:var(--dim); margin-left:6px; font-weight:600; }

.grid { flex:1; min-height:0; display:grid; grid-template-columns: 1.15fr 1.3fr 1.3fr 1fr 1fr; gap:14px; }
.col { display:flex; flex-direction:column; gap:14px; min-height:0; } .col > section { flex:1; }
section { background:var(--card); border:1px solid var(--line); border-radius:26px; padding:18px 20px; min-height:0; display:flex; flex-direction:column; backdrop-filter: blur(12px); overflow:hidden; }
.title { display:flex; align-items:center; gap:10px; color:var(--dim); font-size:15px; font-weight:700; letter-spacing:2px; margin-bottom:12px; }
.title .aside { margin-left:auto; letter-spacing:0; font-weight:600; font-size:15px; color:#cbd5e1; } .title .hot { color:#fb923c; } .tier { color:#4ade80; font-weight:700; } .tier.mid { color:#fbbf24; } .tier.peak { color:#f87171; }
.chev { width:34px; height:34px; border-radius:12px; background:var(--tile); border:1px solid var(--line); display:grid; place-items:center; font-size:22px; color:#cbd5e1; letter-spacing:0; }
[data-act] { cursor:pointer; -webkit-tap-highlight-color:transparent; }

/* energy flow */
.flow { flex:1; min-height:0; display:grid; grid-template-columns: auto 1fr auto 1fr auto; grid-template-rows: auto 1fr auto 1fr auto; align-items:center; justify-items:center; }
.nd { display:flex; flex-direction:column; align-items:center; gap:4px; position:relative; }
.ring { width:76px; height:76px; border-radius:50%; border:3px solid rgba(148,163,184,.35); display:flex; flex-direction:column; align-items:center; justify-content:center; background:rgba(15,20,30,.6); }
.ring ha-icon { --mdc-icon-size:18px; color:var(--dim); }
.ring.on { border-color:var(--c); box-shadow:0 0 22px color-mix(in srgb, var(--c) 45%, transparent), inset 0 0 14px color-mix(in srgb, var(--c) 25%, transparent); } .ring.on ha-icon { color:var(--c); }
.ring .v { font-size:20px; font-weight:800; line-height:1.1; } .ring small { font-size:11px; color:var(--dim); margin-left:2px; font-weight:600; }
.home .ring { width:118px; height:118px; border-width:4px; } .home .ring .v { font-size:30px; } .home ha-icon { --mdc-icon-size:24px; }
.lbl { font-size:11px; letter-spacing:2px; color:var(--dim); font-weight:700; }
.cap { display:flex; flex-direction:column; align-items:center; font-size:12px; line-height:1.25; position:absolute; top:100%; white-space:nowrap; margin-top:4px; }
.cap span { color:var(--dim); letter-spacing:1.5px; font-weight:700; font-size:11px; } .cap b { font-weight:600; color:#cbd5e1; }
.solar .cap { top:auto; left:100%; margin:0 0 0 10px; align-items:flex-start; top:50%; transform:translateY(-50%); }
.gridn .cap, .batt .cap { position:static; }
.ev .cap { top:auto; left:100%; margin:0 0 0 10px; align-items:flex-start; top:50%; transform:translateY(-50%); }
.flow > .nd.gridn, .flow > .nd.batt { margin-top:30px; }
.flow.nosolar { grid-template-rows: auto 1fr auto; }
.ln { background:rgba(148,163,184,.18); border-radius:3px; }
.ln.h { height:3px; width:calc(100% - 12px); } .ln.v { width:3px; height:100%; min-height:14px; }
.ln.on.h { background: repeating-linear-gradient(90deg, var(--c) 0 9px, transparent 9px 16px); animation: fh .9s linear infinite; }
.ln.on.v { background: repeating-linear-gradient(180deg, var(--c) 0 9px, transparent 9px 16px); animation: fv .9s linear infinite; }
.ln.rev { animation-direction: reverse !important; }
@keyframes fh { from { background-position:0 0 } to { background-position:16px 0 } }
@keyframes fv { from { background-position:0 0 } to { background-position:0 16px } }
.stats { display:grid; grid-auto-flow:column; grid-auto-columns:1fr; gap:8px; margin-top:12px; }
.stat { background:var(--tile); border:1px solid var(--line); border-radius:16px; padding:10px 12px; display:flex; flex-direction:column; }
.stat span { font-size:11px; letter-spacing:1.5px; color:var(--dim); font-weight:700; } .stat b { font-size:22px; font-weight:800; } .stat small { font-size:12px; color:var(--dim); margin-left:3px; }
.stat em { font-style:normal; color:#fb923c; font-size:12px; font-weight:700; }

/* quick actions */
.tiles { flex:1; display:grid; grid-template-columns:repeat(3,1fr); grid-auto-rows:1fr; gap:12px; min-height:0; }
.tile, .room { background:var(--tile); border:1px solid var(--line); border-radius:20px; padding:14px 16px; display:flex; flex-direction:column; justify-content:space-between; transition: background .2s; }
.tile b, .room b { display:block; font-size:18px; font-weight:700; } .tile span, .room span { display:block; color:var(--dim); font-size:15px; font-weight:500; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ic { width:44px; height:44px; border-radius:14px; background:rgba(255,255,255,.06); display:grid; place-items:center; color:var(--c, #cbd5e1); }
.tile.on { background: color-mix(in srgb, var(--c) 14%, transparent); border:2px solid color-mix(in srgb, var(--c) 70%, transparent); }
.tile.on .ic { background:var(--c); color:#0d1017; box-shadow:0 0 18px color-mix(in srgb, var(--c) 60%, transparent); } .tile.on span { color:var(--c); font-weight:700; }

/* rooms */
.tabs { display:flex; background:rgba(0,0,0,.25); border-radius:16px; padding:5px; margin-bottom:12px; }
.tab { flex:1; text-align:center; padding:9px; border-radius:12px; font-weight:700; color:var(--dim); font-size:16px; display:flex; justify-content:center; gap:8px; align-items:center; }
.tab.sel { background:rgba(255,255,255,.07); color:#f1f5f9; } .tab i { font-style:normal; background:rgba(251,191,36,.25); color:#fbbf24; border-radius:9px; padding:0 8px; font-size:13px; }
.rooms { flex:1; display:grid; grid-template-columns:1fr 1fr; grid-auto-rows:1fr; gap:12px; min-height:0; }
.room { flex-direction:row; align-items:center; gap:12px; }
.room .nm { flex:1; min-width:0; } .room .ic { color:var(--dim); }
.bulb { width:52px; height:52px; border-radius:16px; border:1px solid var(--line); display:grid; place-items:center; color:var(--dim); flex:none; }
.room.on { background:rgba(251,191,36,.10); border:2px solid rgba(251,191,36,.55); } .room.on .ic { color:#fbbf24; } .room.on span { color:#fbbf24; font-weight:700; }
.room.on .bulb { background:#fbbf24; color:#0d1017; box-shadow:0 0 20px rgba(251,191,36,.55); border:none; }

/* weather */
.now { display:flex; align-items:center; gap:14px; position:relative; }
.now > ha-icon { --mdc-icon-size:64px; }
.big { font-size:56px; font-weight:800; line-height:1; letter-spacing:-1px; } .big sup { font-size:22px; color:var(--dim); margin-left:2px; }
.now b { display:block; font-size:18px; } .now span { color:var(--dim); font-size:15px; }
.now .chip { position:absolute; top:0; right:0; }
.days { display:grid; grid-template-columns:repeat(5,1fr); gap:6px; margin-top:auto; padding-top:10px; }
.day { background:var(--tile); border:1px solid var(--line); border-radius:14px; display:flex; flex-direction:column; align-items:center; padding:6px 2px; font-size:13px; }
.day span { color:#cbd5e1; font-weight:600; } .day b { font-size:17px; } .day small { color:var(--dim); } .day em { color:#60a5fa; font-style:normal; font-size:11px; font-weight:700; }
.chip { display:inline-flex; align-items:center; gap:6px; padding:7px 12px; border-radius:12px; background:var(--tile); border:1px solid var(--line); font-size:14px; font-weight:700; color:#cbd5e1; white-space:nowrap; }
.chip ha-icon { --mdc-icon-size:18px; } .chip.good { color:#4ade80; background:rgba(34,197,94,.10); border-color:rgba(34,197,94,.3); } .chip.violet { color:#a78bfa; background:rgba(139,92,246,.12); border-color:rgba(139,92,246,.3); }

/* calendar */
.ev { display:flex; gap:12px; align-items:center; background:var(--tile); border:1px solid var(--line); border-radius:16px; padding:8px 12px; margin-bottom:8px; }
.ev .date { width:46px; height:46px; border-radius:12px; background:rgba(255,255,255,.06); display:flex; flex-direction:column; align-items:center; justify-content:center; flex:none; }
.ev .date b { font-size:18px; line-height:1; } .ev .date span { font-size:10px; color:var(--dim); letter-spacing:1px; font-weight:700; }
.ev > div:last-child { min-width:0; } .ev > div:last-child b { display:block; font-size:16px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .ev > div:last-child span { color:var(--dim); font-size:13px; }
.ev.today { border-color:rgba(251,146,60,.4); } .ev.today .date { background:rgba(251,146,60,.18); color:#fb923c; }
.empty { color:var(--dim); font-size:15px; }

/* charger */
.chg { display:flex; align-items:center; justify-content:space-between; } .chg span { color:var(--dim); font-size:15px; }
.car { --mdc-icon-size:72px; color:rgba(148,163,184,.35); } .car.on { color:#4ade80; }
.bar { height:10px; border-radius:6px; background:rgba(255,255,255,.08); margin:12px 0; overflow:hidden; } .bar i { display:block; height:100%; background:linear-gradient(90deg,#22c55e,#4ade80); border-radius:6px; }
.bar i.pulse { animation: pulse 2s ease-in-out infinite; } @keyframes pulse { 50% { opacity:.55 } }
.chips { display:flex; gap:8px; flex-wrap:wrap; margin-top:auto; }

/* music */
.music { background: linear-gradient(160deg, var(--card), rgba(20,90,80,.35)); }
.mus { flex:1; display:flex; align-items:center; gap:16px; min-height:0; }
.disc { width:128px; height:128px; border-radius:50%; flex:none; display:grid; place-items:center; background: repeating-radial-gradient(circle, #111 0 2px, #1b1b1b 2px 4px); box-shadow:0 0 0 2px rgba(255,255,255,.04), 0 10px 30px rgba(0,0,0,.5); }
.disc.spin { animation: spin 6s linear infinite; } @keyframes spin { to { transform:rotate(360deg) } }
.disc .label { width:56px; height:56px; border-radius:50%; background:#4c1d95 center/cover; display:grid; place-items:center; color:#c4b5fd; }
.meta { min-width:0; flex:1; display:flex; flex-direction:column; gap:6px; } .meta b { font-size:19px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .meta > span { color:var(--dim); font-size:14px; }
.meta .chip { align-self:flex-start; max-width:100%; overflow:hidden; }
.ctl { display:flex; gap:10px; align-items:center; margin-top:4px; }
.ctl div { width:46px; height:46px; border-radius:50%; background:var(--tile); border:1px solid var(--line); display:grid; place-items:center; }
.ctl .play { width:60px; height:60px; background:#a78bfa; color:#1e1b4b; border:none; box-shadow:0 0 24px rgba(167,139,250,.6); } .ctl .play ha-icon { --mdc-icon-size:30px; }

/* popup */
.pop { position:fixed; inset:0; background:rgba(5,7,12,.7); backdrop-filter:blur(6px); display:grid; place-items:center; z-index:10; padding:24px; }
.sheet { width:min(1900px, 100%); height:100%; background:#10141c; border:1px solid var(--line); border-radius:30px; padding:22px 26px; display:flex; flex-direction:column; gap:16px; }
.phead { display:flex; align-items:center; gap:18px; } .phead h2 { margin:0; font-size:30px; font-weight:800; }
.pic { width:64px; height:64px; border-radius:20px; background:linear-gradient(135deg,#4ade80,#a7f3d0); display:grid; place-items:center; color:#064e3b; } .pic ha-icon { --mdc-icon-size:32px; }
.phead .sub b { color:#f1f5f9; } .phead .dot { margin-right:8px; }
.x { margin-left:auto; width:56px; height:56px; border-radius:18px; background:var(--tile); border:1px solid var(--line); display:grid; place-items:center; } .x ha-icon { --mdc-icon-size:28px; }
.pcard { background:var(--card); border:1px solid var(--line); border-radius:24px; padding:18px 22px; position:relative; min-height:0; }
.pcard h3 { margin:0; font-size:20px; } .pcard .sub { font-size:15px; }
.pbody { flex:1; display:grid; grid-template-columns:1.75fr 1fr; gap:16px; min-height:0; }
.chart { display:flex; flex-direction:column; }
.legend2 { position:absolute; top:22px; right:24px; display:flex; gap:18px; font-size:15px; font-weight:600; color:#cbd5e1; }
.legend2 i { display:inline-block; width:12px; height:12px; border-radius:4px; margin-right:6px; vertical-align:-1px; } .legend2 i.dash { height:3px; width:16px; background:#a78bfa; vertical-align:3px; }
.plot { flex:1; position:relative; margin:14px 0 22px 52px; min-height:0; }
.plot svg { width:100%; height:100%; display:block; overflow:visible; }
.plot .s { stroke-width:2; vector-effect:non-scaling-stroke; } .plot .dash { stroke-dasharray:6 5; }
.plot .gl { stroke:rgba(255,255,255,.07); vector-effect:non-scaling-stroke; } .plot .now { stroke:rgba(255,255,255,.5); stroke-dasharray:4 4; vector-effect:non-scaling-stroke; }
.yl span { position:absolute; left:-52px; transform:translateY(-50%); font-size:12px; color:var(--dim); width:46px; text-align:right; }
.xl span { position:absolute; bottom:-22px; transform:translateX(-50%); font-size:12px; color:var(--dim); }
.prow { display:grid; grid-template-rows:auto 1fr; gap:16px; min-height:0; }
.donut { display:flex; align-items:center; gap:24px; margin-top:10px; } .donut svg { width:150px; flex:none; }
.dp { fill:#f1f5f9; font-size:34px; font-weight:800; text-anchor:middle; font-family:Manrope, sans-serif; } .dl { fill:var(--dim); font-size:13px; text-anchor:middle; font-family:Manrope, sans-serif; }
.legend { flex:1; display:flex; flex-direction:column; gap:12px; font-size:17px; }
.legend div { display:grid; grid-template-columns:20px 1fr auto 50px; align-items:center; gap:8px; } .legend i { width:14px; height:14px; border-radius:5px; } .legend span { color:var(--dim); text-align:right; }
.totals { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-top:12px; }
.totals .stat b { font-size:26px; } .totals .stat em { color:var(--dim); font-weight:500; font-size:14px; }
.stat b.y { color:#fbbf24; } .stat b.g { color:#4ade80; } .stat.good { background:rgba(34,197,94,.08); border-color:rgba(34,197,94,.25); }

@media (max-width: 1800px) {
  :host { height:auto; }
  .grid { grid-template-columns: 1fr 1fr; } .grid > section { min-height:480px; }
  header { flex-wrap:wrap; gap:12px; }
}
`;

if (!customElements.get('edgelit-panel-card')) {
  customElements.define('edgelit-panel-card', EdgelitPanelCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'edgelit-panel-card', name: 'Edgelit panel', description: 'Full-screen home control panel for a wall display.' });
}
