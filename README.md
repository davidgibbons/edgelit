# Edgelit

Home Assistant cards sized for the Corsair Xeneon Edge, a 2560×720 touchscreen
strip. Both are plain JS modules with no build step. On narrower screens they
drop to two columns.

- **`edgelit-panel-card`** draws a whole home view: header, energy flow, quick
  actions, rooms, weather, calendar, EV charger and music. Tap the energy card
  for today's hour-by-hour chart.
- **`edgelit-hosts-card`** draws one rack of machines: a stacked 24-hour power
  chart, a card per host with load and memory plus either pods or inference
  activity, and an infrastructure or Claude-usage card at the end.

## Install

1. In HACS, add this repository as a custom repository of type **Dashboard**.
2. Install **Edgelit**. HACS registers `/hacsfiles/edgelit/edgelit.js`, which
   loads both cards.
3. Use the cards in a **panel** view, one card per view:
   `type: custom:edgelit-panel-card` or `type: custom:edgelit-hosts-card`.

After an update, reload any open dashboard page. A page that was open before
the install shows "Configuration error" for these cards until it reloads.

## `edgelit-panel-card`

Every key is optional. The header always renders. `weather`, `charger` and
`media` drop out when unset; the energy, quick-actions, rooms and calendar
sections stay on the grid and render empty.

| Key | Purpose |
|---|---|
| `name` | Name in the greeting. Defaults to the logged-in HA user. |
| `weather` | `weather.*` entity. The card reads its daily forecast. |
| `people` | `person.*` entities shown as avatars. Dimmed when away. |
| `calendars` | `calendar.*` entities. Shows the next three events in 14 days. |
| `energy` | Power, energy, tariff and cost sensors. See below. |
| `actions` | Quick-action tiles. See below. |
| `rooms` | `{name, icon, group, temp, lights}`. `group` makes the tabs. Tapping the bulb toggles every light in the room. |
| `charger` | `state`, `power`, `cable`, `energy`, `miles`, `schedule`, `schedule_start`, `schedule_end` entities |
| `media` | `media_player.*` entities. The card shows the first one playing, else the first one available. |

### `energy`

Power sensors can be W or kW. `battery` is positive while charging. Without
solar, leave out `solar` and `solar_today` to hide solar everywhere on the
card.

- Live power: `solar`, `home`, `grid_import`, `grid_export`, `battery`,
  `battery_soc`, `ev`, `ev_state`
- Today's totals: `solar_today`, `home_today`, `import_today`, `export_today`,
  `charge_today`, `discharge_today`
- Pricing: `rate` is a tariff sensor whose `all_rates` attribute lists every
  tier, such as one from the OpenEI integration; the card takes the current
  tier from it. `price` is the all-in $/kWh for that tier. `cost_today` is the
  cost sensor the Energy dashboard creates for the grid source when it prices
  with `price`.

The card shows `cost_today` as today's spend. **Battery saved** prices each
5 minutes of battery output at the rate in effect then, minus charging priced
the same way.

The chart and battery savings read 5-minute statistics, so the live power
sensors need a `state_class`.

### `actions`

Each tile is `{entity, name, icon, color, tap}`. `tap` defaults by domain:
lights, switches, fans and `input_boolean`s toggle, scripts run, everything
else opens more-info. Two
tiles don't need an entity:

- `type: lights` with `entities:` shows how many are on, and a tap turns them
  all off.
- `type: reload` reloads the page.

## `edgelit-hosts-card`

Power and cost come from Home Assistant. Everything else comes from a
Prometheus-compatible server (built and tested against VictoriaMetrics), which
the browser queries directly.

| Key | Purpose |
|---|---|
| `prometheus` | **Required.** Query API base URL, such as `https://prometheus.example.lan`. It must answer CORS requests from the HA origin. |
| `rate` | **Required.** Sensor holding the electricity price in $/kWh. |
| `hosts` | **Required.** One card each, in order. See below. |
| `title`, `subtitle` | Header text. |
| `infra` | Optional end card: `switch` (a power sensor, also stacked in the chart), `air_top` and `air_bottom` (temperature sensors), `ceph: true`, `alerts: true`. Setting `alerts` makes the header pill count firing alerts and crashlooping pods. |
| `usage` | Optional end card when there is no `infra`: Claude usage sensors `session`, `session_reset`, `week`, `week_reset`. |

Each host is `{name, node, power, color, temp_chip, inference}`:

- `node` is the Kubernetes node name. node-exporter series must carry it as
  `nodename`, and kube-state-metrics series as `node`.
- `power` is the host's power sensor, usually a smart plug.
- `temp_chip` is the `node_hwmon_temp_celsius` chip shown as TEMP. It defaults
  to `platform_coretemp_0` (Intel). AMD hosts usually report k10temp as
  `pci0000:00_0000:00:18_3`; check
  `max by (chip) (node_hwmon_temp_celsius{nodename="<node>"})`. Any NVMe drive
  above 65 °C is called out under the bars.
- `inference: true` adds the model row: name, serving or idle, request pips,
  tokens/s, tokens today and KV cache. It reads `vllm:*` and `llamacpp:*`
  series, which must carry a `nodename` label (relabel it from
  `__meta_kubernetes_pod_node_name` in the scrape). llama.cpp has no model-name
  label, so the card shows the scraped Service name. With no model on the
  node, the card shows "no model loaded".

The card queries every 30 seconds, one request per value, so a failed query
blanks only its own field. If the server doesn't answer at all, power and cost
still render and the header says "Metrics unavailable".

Today's cost multiplies today's energy by the current rate. A rate that
changes during the day makes that figure an estimate.

## Develop

Run the tests, which drive the hosts card under Node with stubbed DOM, `hass`
and `fetch`:

```sh
node test/edgelit-hosts-card.test.mjs
```

A card only needs a `hass` object, so a static page with mock states can render
it at 2560×720 for screenshots. Stub `<ha-icon>` with the
[MDI webfont](https://cdn.jsdelivr.net/npm/@mdi/font/), because HA's icon
element isn't available outside the frontend. For the hosts card, also stub
`window.fetch` to return canned query responses.
