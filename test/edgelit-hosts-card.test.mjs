// Drives edgelit-hosts-card without a browser or Home Assistant: the pure
// helpers, then one render against canned VictoriaMetrics and hass data.
import assert from 'node:assert/strict';

const main = { innerHTML: '' };
globalThis.HTMLElement = class {
  attachShadow() { this.shadowRoot = { innerHTML: '', addEventListener() {}, getElementById: () => main }; return this.shadowRoot; }
  dispatchEvent() {}
};
const registry = {};
globalThis.customElements = { get: (n) => registry[n], define: (n, c) => { registry[n] = c; } };
globalThis.document = { querySelector: () => true, head: { insertAdjacentHTML() {} } };
globalThis.window = {};
globalThis.setInterval = () => 0;

const card = await import('../dist/edgelit-hosts-card.js');

// Helpers
assert.equal(card.workloadName('vmsingle-victoria-metrics-k8s-stack-5cf9bbcdd8-gtksk'), 'vmsingle-victoria-metrics-k8s-stack');
assert.equal(card.workloadName('kometa-overlays-29848035-6d62q'), 'kometa-overlays');
assert.equal(card.workloadName('cilium-qb2dg'), 'cilium');
assert.equal(card.workloadName('argocd-application-controller-0'), 'argocd-application-controller-0');
assert.equal(card.costPerHour(500, 0.4), 0.2);
const now = Date.now();
assert.equal(card.wattHours([{ start: now, mean: 60 }, { start: now - 1e9, mean: 60 }, { start: now, mean: null }], now - 1), 5);
assert.equal(card.fmtUptime(3 * 86400 + 5), '3d');
assert.equal(card.fmtUptime(7200), '2h');
assert.equal(card.fmtTokens(182400), '182k');
assert.equal(card.esc('<b>'), '&lt;b&gt;');
const vec = (rows) => ({ data: { result: rows.map(([metric, v]) => ({ metric, value: [0, String(v)] })) } });
assert.equal(card.byLabel(vec([[{ nodename: 'a' }, 2]]), 'nodename').get('a'), 2);

// Render: one cluster node, one inference node with vLLM, one scaled to zero.
const answers = [
  [/^100 \* \(1 - avg/, vec([[{ nodename: 'node01' }, 18], [{ nodename: 'spark01' }, 4]])],
  [/^count by \(nodename\)/, vec([[{ nodename: 'node01' }, 16]])],
  [/MemTotal/, vec([[{ nodename: 'node01' }, 64e9]])],
  [/MemAvailable/, vec([[{ nodename: 'node01' }, 40e9]])],
  [/MemFree/, vec([[{ nodename: 'node01' }, 30e9]])],
  [/hwmon/, vec([[{ nodename: 'node01', chip: 'platform_coretemp_0' }, 52], [{ nodename: 'node01', chip: 'nvme_nvme1' }, 77]])],
  [/boot_time/, vec([[{ nodename: 'node01' }, 6 * 86400]])],
  [/kube_node_status_condition/, vec([[{ node: 'node01' }, 1], [{ node: 'spark01' }, 1], [{ node: 'strix01' }, 1]])],
  [/phase="Running"/, vec([[{ node: 'node01' }, 57]])],
  [/phase="Pending"/, vec([[{ node: 'node01' }, 0]])],
  [/CrashLoopBackOff/, vec([[{ node: 'node01', namespace: 'soju', pod: 'soju-0' }, 1]])],
  [/^topk/, vec([[{ node: 'node01', pod: 'plex-7d9f8b6c5d-abcde' }, 1.2]])],
  [/vllm:generation_tokens_total\[2m\]/, vec([[{ nodename: 'spark01', model_name: 'artemis-31b-nvfp4' }, 41]])],
  [/vllm:num_requests_running/, vec([[{ nodename: 'spark01', model_name: 'artemis-31b-nvfp4' }, 2]])],
  [/vllm:kv_cache_usage_perc/, vec([[{ nodename: 'spark01', model_name: 'artemis-31b-nvfp4' }, 0.38]])],
];
globalThis.fetch = async (url) => {
  assert.ok(url.startsWith('http://vm.test/api/v1/'), `queries the configured base: ${url}`);
  const expr = decodeURIComponent(new URL(url).searchParams.get('query'));
  if (url.includes('query_range')) return { ok: true, json: async () => ({ data: { result: [] } }) };
  const hit = answers.find(([re]) => re.test(expr));
  return { ok: true, json: async () => hit?.[1] ?? vec([]) };
};

const el = new registry['edgelit-hosts-card']();
assert.throws(() => el.setConfig({ hosts: [] , rate: 'sensor.r' }), /`prometheus` is required/);
el.setConfig({
  title: 'Test',
  prometheus: 'http://vm.test/',
  rate: 'sensor.rate',
  hosts: [
    { name: 'node01', node: 'node01', power: 'sensor.n1', color: '#f97316' },
    { name: 'spark01', node: 'spark01', power: 'sensor.s1', inference: true },
    { name: 'strix01', node: 'strix01', power: 'sensor.x1', inference: true },
  ],
});
const st = (v) => ({ state: String(v), attributes: {} });
el.hass = {
  states: { 'sensor.n1': st(50), 'sensor.s1': st(60), 'sensor.x1': st('unavailable'), 'sensor.rate': st(0.4) },
  callWS: async () => ({ 'sensor.n1': [{ start: now, mean: 50 }] }),
};
await new Promise((r) => setTimeout(r, 20));
const html = main.innerHTML;

assert.match(html, /110 W/, 'header totals the live draw');
assert.match(html, /\$0\.044\/hr/, 'header prices it at the rate');
assert.match(html, /\$0\.020\/hr/, 'node01 costs 50 W at $0.40');
assert.match(html, /18% <span class="dim">16c/, 'cpu and cores');
assert.match(html, /24\/64 G/, 'memory used of total');
assert.match(html, /52°C/, 'cpu temp from the configured chip');
assert.match(html, /NVMe 77°C/, 'hot nvme called out');
assert.match(html, /soju-0 crashlooping/, 'crashloop named');
assert.match(html, /plex 1\.2/, 'busiest workload without its pod hash');
assert.match(html, /artemis-31b-nvfp4/, 'vllm model name');
assert.match(html, /serving/, 'busy model chip');
assert.match(html, /KV<\/span>.*38%/s, 'kv cache');
assert.match(html, /no model loaded/, 'scaled-to-zero host');
assert.match(html, /1 \/ 2 models loaded/, 'ai health pill');
assert.doesNotMatch(html, /NaN|undefined/, 'no raw NaN or undefined');

// Metrics down: power still renders, one header note instead of errors.
globalThis.fetch = async () => { throw new Error('offline'); };
await el._loadVm();
assert.match(main.innerHTML, /Metrics unavailable/);
assert.match(main.innerHTML, /110 W/);
assert.doesNotMatch(main.innerHTML, /NaN|undefined/);

console.log('edgelit-hosts-card: ok');
