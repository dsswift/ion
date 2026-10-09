// Contract tests for the Ion Performance pack and the Prometheus target shape
// it introduced. Span metrics live in Prometheus, so a dashboard now mixes
// two stores; these pin that a PromQL target is emitted the way Grafana's
// Prometheus datasource reads it, that it is still scoped by Device and User,
// that it reads the span names and dimensions the stack records, and that the
// Wire Latency statistics say what they are.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildDashboard } from '../src/dashboard.ts';
import { RECIPES } from '../src/dashboards/index.ts';
import { performanceDashboard } from '../src/dashboards/performance.ts';
import { wireLatencyDashboard } from '../src/dashboards/wire-latency.ts';
import { stat, timeseries } from '../src/panels.ts';
import { accumulation } from '../src/queries.ts';
import { spanQuantile, spanSelector } from '../src/queries-spans.ts';
import { wireWindowStat } from '../src/queries-latency.ts';
import { auditOvercount } from '../src/check.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBSERVABILITY = join(HERE, '..', '..');

type Json = Record<string, any>;

function targets(d: Json): Json[] {
  const out: Json[] = [];
  const walk = (panels: Json[]): void => {
    for (const p of panels) {
      for (const t of p.targets ?? []) out.push({ ...t, __panel: p });
      if (Array.isArray(p.panels)) walk(p.panels);
    }
  };
  walk(d.panels);
  return out;
}

const built = () => buildDashboard(performanceDashboard()) as Json;

test('performance pack: registered in the reliability folder', () => {
  const d = performanceDashboard();
  assert.ok(RECIPES.some((r) => r().uid === d.uid), 'recipe must be registered');
  assert.equal(d.folder, 'reliability');
  assert.equal(d.file, 'ion-performance');
  assert.deepEqual(
    (d.templating ?? []).map((v) => v.name),
    ['backend', 'model', 'transport', 'client_kind'],
    'the four span-metrics dimensions are dropdowns; Device and User are global',
  );
  for (const v of d.templating ?? []) {
    assert.equal(v.datasource?.type, 'prometheus', `${v.name} lists Prometheus label values`);
    assert.equal(v.allValue, '.*', `${v.name}: All must also match spans without the attribute`);
  }
});

test('a Prometheus target carries the Prometheus datasource and the instant/range booleans', () => {
  const prom = targets(built()).filter((t) => t.datasource?.type === 'prometheus');
  assert.ok(prom.length > 0, 'the pack reads span metrics');
  for (const t of prom) {
    assert.equal(t.datasource.uid, 'prometheus');
    assert.equal(typeof t.instant, 'boolean', `${t.__panel.title}: instant flag`);
    assert.equal(typeof t.range, 'boolean', `${t.__panel.title}: range flag`);
    assert.notEqual(t.instant, t.range, `${t.__panel.title}: exactly one evaluation mode`);
    assert.equal(t.range, t.__panel.type === 'timeseries', `${t.__panel.title}: series panels evaluate per step`);
    assert.ok(!t.expr.includes('$__interval'), `${t.__panel.title}: PromQL rates use $__rate_interval or $__range, never $__interval`);
  }
});

test('a panel declares its store: Prometheus, Loki, or Mixed when its targets differ', () => {
  const d = built();
  for (const p of d.panels as Json[]) {
    if (!p.targets) continue;
    const kinds = new Set((p.targets as Json[]).map((t) => t.datasource.type));
    const want = kinds.size > 1 ? 'datasource' : [...kinds][0];
    assert.equal(p.datasource.type, want, `${p.title}: panel datasource`);
  }
  const mixed = timeseries({
    id: 1,
    title: 'mixed',
    gridPos: { h: 1, w: 1, x: 0, y: 0 },
    targets: [
      { e: spanQuantile({ q: 0.95, sel: { span: 'run.execute' } }) },
      { e: accumulation('sum(count_over_time({event_name="run.complete"} | json [$__interval]))', '$__interval'), refId: 'B' },
    ],
  }) as Json;
  assert.deepEqual(mixed.datasource, { type: 'datasource', uid: '-- Mixed --' });
});

test('every PromQL selector is scoped by Device and User like a Loki selector', () => {
  for (const t of targets(built()).filter((t) => t.datasource?.type === 'prometheus')) {
    const selectors = (t.expr as string).match(/\{[^{}]*\}/g) ?? [];
    assert.ok(selectors.length > 0, `${t.__panel.title}: a PromQL target needs a selector for the identity matchers to join: ${t.expr}`);
    for (const s of selectors) {
      assert.ok(s.includes('host_name=~"$host"') && s.includes('user=~"$user"'), `${t.__panel.title}: unscoped ${s}`);
    }
  }
});

test('the span-metrics dimensions the pack splits by are the ones Tempo records', () => {
  const tempo = readFileSync(join(OBSERVABILITY, 'tempo-config.yaml'), 'utf8');
  const block = tempo.slice(tempo.indexOf('span_metrics:'), tempo.indexOf('service_graphs:'));
  const recorded = new Set([...block.matchAll(/^\s*-\s*([a-z_.]+)\s*$/gm)].map((m) => m[1].replace(/\./g, '_')));
  for (const want of ['host_name', 'user']) assert.ok(recorded.has(want), `Tempo must record ${want} for the identity filters`);
  const used = new Set<string>();
  for (const t of targets(built()).filter((t) => t.datasource?.type === 'prometheus')) {
    for (const m of (t.expr as string).matchAll(/\b([a-z_]+)(?:=~|=)"/g)) used.add(m[1]);
    for (const m of (t.expr as string).matchAll(/by \(([^)]*)\)/g)) for (const l of m[1].split(',')) used.add(l.trim());
  }
  const intrinsic = new Set(['le', 'service', 'span_name', 'span_kind', 'status_code']);
  const missing = [...used].filter((l) => !intrinsic.has(l) && !recorded.has(l));
  assert.deepEqual(missing, [], 'a label a panel selects or groups on must be an intrinsic or a recorded dimension');
});

test('spanSelector writes one value as equality and several as a regex', () => {
  assert.equal(spanSelector({ span: 'run.execute', service: 'ion-engine' }), '{span_name="run.execute", service="ion-engine"}');
  assert.equal(spanSelector({ span: ['a', 'b'], extra: ['model=~"$model"'] }), '{span_name=~"a|b", model=~"$model"}');
});

test('span-metrics expressions never trip the overcount audit', () => {
  const d = built();
  assert.deepEqual(auditOvercount(d), []);
  // And an instant stat accepts them: no accumulation class is involved.
  assert.doesNotThrow(() =>
    stat({ id: 1, title: 's', gridPos: { h: 1, w: 1, x: 0, y: 0 }, targets: [{ e: spanQuantile({ q: 0.95, sel: { span: 'daemon.startup' } }) }] }),
  );
});

test('the alert rules read the same span names the dashboard charts', () => {
  const rules = readFileSync(join(OBSERVABILITY, 'grafana', 'provisioning', 'alerting', 'ion-rules.yaml'), 'utf8');
  const charted = new Set<string>();
  for (const t of targets(built()).filter((t) => t.datasource?.type === 'prometheus')) {
    for (const m of (t.expr as string).matchAll(/span_name="([^"]+)"/g)) charted.add(m[1]);
  }
  for (const m of rules.matchAll(/span_name="([^"]+)"/g)) {
    assert.ok(charted.has(m[1]), `alert reads span ${m[1]}, which no Performance panel charts`);
  }
  for (const uid of ['ion-store-action-p95', 'ion-run-p95', 'ion-server-event-loop-p99', 'ion-host-memory-low']) {
    assert.ok(rules.includes(`uid: ${uid}`), `missing alert ${uid}`);
  }
});

test('wire latency: a per-minute percentile field combines as that percentile, and says so', () => {
  const p95 = wireWindowStat({ field: 'fields_rtt_p95_ms', window: '5m' });
  assert.ok(p95.expr.startsWith('quantile_over_time(0.95, '), p95.expr);
  const p50 = wireWindowStat({ field: 'fields_rtt_p50_ms', window: '5m' });
  assert.ok(p50.expr.startsWith('quantile_over_time(0.5, '), p50.expr);
  const peak = wireWindowStat({ field: 'fields_queue_max', window: '5m', agg: 'max' });
  assert.ok(peak.expr.startsWith('max_over_time('), peak.expr);
  const d = wireLatencyDashboard();
  for (const p of d.panels as Json[]) {
    const quantiles = ((p.targets ?? []) as Json[]).filter((t) => /quantile_over_time/.test(t.expr));
    if (quantiles.length) assert.match(p.description, /per-minute|each minute/, `${p.title}: a quantile of per-minute summaries must say so`);
  }
});

test('no panel description promises data from an unshipped phase', () => {
  for (const recipe of RECIPES) {
    const d = buildDashboard(recipe()) as Json;
    for (const p of d.panels as Json[]) {
      assert.ok(!/Phase[- ]B/.test(p.description ?? ''), `${d.uid} "${p.title}": stale phase note`);
    }
  }
});
