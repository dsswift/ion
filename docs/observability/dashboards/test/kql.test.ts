// Contract tests for the Azure Monitor (KQL) flavor of the dashboard suite.
//
// The Azure twin is compiled from the Loki suite, so these pin two things: the
// compiler maps each LogQL construct to the KQL that means the same thing, and
// the whole suite converts with nothing Loki-shaped left behind and no panel
// lost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMetric, parseLogQuery } from '../src/kql/logql.ts';
import { compileMetric, compileStream, type CompileOptions } from '../src/kql/compile.ts';
import { toAzure } from '../src/kql/dashboard.ts';
import { loadTarget, parseTarget, withViews } from '../src/kql/target.ts';
import { buildAzure } from '../src/generate-azure.ts';
import { buildDashboard } from '../src/dashboard.ts';
import { RECIPES } from '../src/dashboards/index.ts';

const TARGET = loadTarget(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'azure-target.json'));
const RANGE: CompileOptions = { mode: 'range', multiVars: new Set(['host', 'user']) };
const INSTANT: CompileOptions = { mode: 'instant', multiVars: new Set(['host', 'user']) };
const TEL = '{event_name="run.complete"}';

const kql = (expr: string, opts: CompileOptions) => compileMetric(parseMetric(expr), opts).query;

// ---------------------------------------------------------------------------
// Time follows the query class
// ---------------------------------------------------------------------------

test('a range accumulation over $__interval bins by $__interval', () => {
  const q = kql(`sum(sum_over_time(${TEL} | json | unwrap payload_run_cost_usd [$__interval]))`, RANGE);
  assert.match(q, /summarize Value = sum\(_v\) by TimeGenerated = bin\(TimeGenerated, \$__interval\)/);
  assert.match(q, /\$__timeFilter\(TimeGenerated\)/);
});

test('an instant fixed window reads the window before the dashboard end, as Loki evaluates it', () => {
  const q = kql(`sum(count_over_time({service_name="ion-engine", event_name=""}[24h]))`, INSTANT);
  assert.match(q, /TimeGenerated > \$__timeTo\(\) - 24h and TimeGenerated <= \$__timeTo\(\)/);
  assert.doesNotMatch(q, /\$__timeFilter/);
});

test('a rolling count on a range panel keeps its per-window meaning at any step', () => {
  const q = kql(`sum(count_over_time({service_name="ion-engine", event_name=""}[5m]))`, RANGE);
  assert.match(q, /bin\(TimeGenerated, max_of\(5m, \$__interval\)\)/);
  assert.match(q, /Value = todouble\(Value\) \* \(5m \/ max_of\(5m, \$__interval\)\)/);
});

// ---------------------------------------------------------------------------
// Fields, filters, and variables
// ---------------------------------------------------------------------------

test('telemetry names resolve into the payload and context bags; event_name selects the telemetry view', () => {
  const q = kql(`sum by (payload_model, context_extension) (count_over_time(${TEL} | json [$__range]))`, INSTANT);
  assert.match(q, /^IonTelemetry\n/m);
  assert.match(q, /where event_name == @"run\.complete"/);
  assert.match(q, /payload_model = tostring\(payload\[@"model"\]\)/);
  assert.match(q, /context_extension = tostring\(context\[@"extension"\]\)/);
});

test('structured-metadata aliases map back to the event path they came from', () => {
  const q = kql(`sum(sum_over_time(${TEL} | unwrap cache_read_tokens [$__range]))`, INSTANT);
  assert.match(q, /todouble\(payload\[@"cache_read_input_tokens"\]\)/);
});

test('operational-log fields read the fields bag; json params alias a body path', () => {
  const q = kql('sum by (device_model) (count_over_time({service_name="ion-ios", event_name=""} | json device_model="fields.device_model" [$__range]))', INSTANT);
  assert.match(q, /device_model = tostring\(fields\[@"device_model"\]\)/);
  assert.throws(() => kql('sum(count_over_time({service_name="ion-ios", event_name=""} | json | context_session_id="x" [5m]))', INSTANT), /no logs field/);
});

test('a log selector reads the logs view on its service, leaving telemetry out', () => {
  const q = kql('sum(count_over_time({service_name="ion-extension", event_name=""}[$__range]))', INSTANT);
  assert.match(q, /^IonLogs\n/m);
  assert.match(q, /where ServiceName == @"ion-extension"/);
  assert.doesNotMatch(q, /event_name/);
  const all = kql('sum(count_over_time({event_name=~".+"}[$__range]))', INSTANT);
  assert.match(all, /^IonTelemetry\n/m);
});

test('the trace, span, and source read the OTLP-native view columns', () => {
  const q = compileStream(parseLogQuery('{event_name="llm.call"} | trace_id != "" | service_instance_id=~"$install"'), RANGE).query;
  assert.match(q, /where isnotempty\(TraceId\)/);
  assert.match(q, /where ServiceInstanceId matches regex/);
  const logs = kql('sum by (service_name, host_name) (count_over_time({service_name=~".+", event_name="", span_id!=""}[$__range]))', INSTANT);
  assert.match(logs, /isnotempty\(SpanId\)/);
  assert.match(logs, /by service_name = ServiceName, host_name/);
});

test('Device and User filter by list, and All (the __all__ sentinel) keeps unlabeled lines', () => {
  const q = kql('sum(count_over_time({service_name="ion-engine", event_name="", host_name=~"$host"}[$__range]))', INSTANT);
  assert.match(q, /\(host_name in \(\$\{host:singlequote\}\) or @"__all__" in \(\$\{host:singlequote\}\)\)/);
});

test('All interpolated the way Grafana does it yields a KQL string, not a column name', () => {
  const az = toAzure(buildDashboard(RECIPES[0]()), TARGET);
  const vars = (az.templating as { list: Record<string, unknown>[] }).list;
  const allValue = vars.find((x) => x.name === 'host')!.allValue as string;
  const q = kql('sum(count_over_time({service_name="ion-engine", event_name="", host_name=~"$host"}[$__range]))', INSTANT);
  // Grafana drops a custom allValue in as-is, ignoring the :singlequote format.
  const sent = q.replaceAll('${host:singlequote}', allValue);
  assert.match(sent, /\(host_name in \('__all__'\) or @"__all__" in \('__all__'\)\)/);
  assert.doesNotMatch(sent, /in \(__all__\)/);
});

test('a regex textbox variable matches anchored, like a Loki =~ matcher', () => {
  const q = kql(`sum(count_over_time(${TEL} | json | payload_model=~"$model" [$__range]))`, INSTANT);
  assert.match(q, /tostring\(payload\[@"model"\]\) matches regex @"\^\(\?:\$model\)\$"/);
});

test('a coalesce runs before the filter that follows it, so the fallback bucket is selectable', () => {
  const q = kql(
    `sum by (user) (count_over_time(${TEL} | json | label_format user=\`{{if .user}}{{.user}}{{else}}unassigned{{end}}\` | user=~"$user" [$__range]))`,
    INSTANT,
  );
  const coalesce = q.indexOf('extend user = iff(isempty(user), @"unassigned", user)');
  const filter = q.lastIndexOf('user in (${user:singlequote})');
  assert.ok(coalesce > 0 && filter > coalesce, q);
});

// ---------------------------------------------------------------------------
// Vector composition
// ---------------------------------------------------------------------------

test('vector division joins on the shared labels and divides as reals', () => {
  const q = kql(
    `sum by (payload_model) (sum_over_time(${TEL} | json | unwrap payload_run_cost_usd [$__range])) / sum by (payload_model) (count_over_time(${TEL} | json [$__range]))`,
    INSTANT,
  );
  assert.match(q, /join kind=inner \(/);
  assert.match(q, /\) on payload_model/);
  assert.match(q, /Value = todouble\(Value\) \/ _r/);
});

test('a comparison against a number keeps only the series where it holds', () => {
  const q = kql(`count(sum by (payload_tool) (count_over_time(${TEL} | json [5m])) > 3)`, INSTANT);
  assert.match(q, /\| where Value > 3\n\| summarize Value = count\(\)/);
});

test('label_replace becomes a conditional extend', () => {
  const q = kql(`label_replace(sum by (payload_session_id) (count_over_time(${TEL} | json [$__range])), "context_session_id", "$1", "payload_session_id", "(.+)")`, INSTANT);
  assert.match(q, /extend context_session_id = iff\(payload_session_id matches regex @"\^\(\?:\(\.\+\)\)\$", replace_regex\(payload_session_id, .*, @"\\1"\), ""\)/);
});

test('the freshness detector subtracts the newest line from the dashboard end, in minutes', () => {
  const q = kql(
    '(vector(${__to:date:seconds}) - on() group_right() max by (service_name) (max_over_time({service_name=~".+", event_name=""} | label_format ts_unix="{{ __timestamp__ | unixEpoch }}" | unwrap ts_unix [24h]))) / 60',
    INSTANT,
  );
  assert.match(q, /extend ts_unix = \(TimeGenerated - datetime\(1970-01-01\)\) \/ 1s/);
  assert.match(q, /Value = \(\(\$__timeTo\(\) - datetime\(1970-01-01\)\) \/ 1s\) - todouble\(Value\)/);
  assert.match(q, /Value = todouble\(Value\) \/ 60/);
});

test('a construct outside the supported subset fails generation instead of emitting a wrong panel', () => {
  assert.throws(() => kql('sum(bytes_over_time({service_name="ion-engine", event_name=""}[5m]))', RANGE), /unsupported function bytes_over_time/);
  assert.throws(() => kql(`stddev(count_over_time(${TEL}[5m]))`, RANGE), /unsupported function stddev/);
});

test('a stream query returns the newest 1000 matching rows', () => {
  const { query } = compileStream(parseLogQuery('{service_name="ion-engine", event_name=""} | json | level = "ERROR"'), RANGE);
  assert.match(query, /where level == @"ERROR"\n\| top 1000 by TimeGenerated desc$/);
});

// ---------------------------------------------------------------------------
// Target config
// ---------------------------------------------------------------------------

test('a target config without every view is rejected', () => {
  assert.throws(() => parseTarget({ ...TARGET, views: { IonTelemetry: 'x', IonLogs: 'y' } }), /views\.IonSpans/);
  assert.throws(() => parseTarget({ ...TARGET, resources: ['not-an-arm-id'] }), /not an ARM id/);
});

test('each query carries only the view bindings it reads', () => {
  const q = withViews(TARGET, 'IonLogs | take 1');
  assert.equal(q, 'let IonLogs = ExampleLogs;\nIonLogs | take 1');
});

// ---------------------------------------------------------------------------
// The whole suite
// ---------------------------------------------------------------------------

function walk(v: unknown, fn: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(v)) v.forEach((x) => walk(x, fn));
  else if (v && typeof v === 'object') {
    fn(v as Record<string, unknown>);
    Object.values(v).forEach((x) => walk(x, fn));
  }
}

function panelsOf(d: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const add = (ps: unknown) =>
    (ps as Record<string, unknown>[]).forEach((p) => {
      if (p.type !== 'row') out.push(p);
      if (Array.isArray(p.panels)) add(p.panels);
    });
  add(d.panels);
  return out;
}

test('every recipe converts, keeping every panel, and nothing Loki- or Tempo-shaped remains', () => {
  for (const recipe of RECIPES) {
    const loki = buildDashboard(recipe());
    const az = toAzure(loki, TARGET);
    const lp = panelsOf(loki);
    const ap = panelsOf(az);
    assert.equal(ap.length, lp.length, `${loki.uid}: panel count`);
    ap.forEach((p, i) => {
      assert.equal(p.id, lp[i].id, `${loki.uid}: panel order`);
      const lt = (lp[i].targets as Record<string, unknown>[] | undefined) ?? [];
      const at = (p.targets as Record<string, unknown>[] | undefined) ?? [];
      assert.deepEqual(at.map((t) => t.refId), lt.map((t) => t.refId), `${loki.uid} / ${p.title as string}: targets`);
    });
    walk(az, (o) => {
      const ds = o.datasource as Record<string, unknown> | undefined;
      // A PromQL target keeps its expr and points at the workspace's
      // Prometheus data source; a Mixed panel keeps Grafana's Mixed marker.
      const prom = ds !== undefined && JSON.stringify(ds) === JSON.stringify(TARGET.prometheus);
      if (!prom) assert.ok(!('expr' in o), `${loki.uid}: a LogQL expr survived`);
      if (ds && typeof ds === 'object' && !prom && ds.type !== 'datasource') assert.deepEqual(ds, TARGET.datasource, `${loki.uid}: data source`);
    });
  }
});

test('the Tempo dispatch tree becomes a span table that points at Application Insights', () => {
  const forensics = buildAzure('/out', TARGET).find((a) => a.path.endsWith('ion-forensics.json'));
  assert.ok(forensics);
  const tree = panelsOf(JSON.parse(forensics.content)).find((p) => p.title === 'Dispatch tree');
  assert.equal(tree?.type, 'table');
  assert.match(tree?.description as string, /Application Insights/);
  const q = ((tree?.targets as Record<string, Record<string, string>>[])[0].azureLogAnalytics).query;
  assert.match(q, /where session_id == @"\$session"\n\| where Name == @"dispatch\.agent"/);
  assert.match(q, /project TimeGenerated, Name, TraceId, SpanId, ParentSpanId, DurationMs/);
});

test('Device and User become Log Analytics variables whose All is the sentinel', () => {
  const az = toAzure(buildDashboard(RECIPES[0]()), TARGET);
  const vars = (az.templating as { list: Record<string, unknown>[] }).list;
  for (const [name, col] of [['host', 'host_name'], ['user', 'user']]) {
    const v = vars.find((x) => x.name === name)!;
    assert.equal(v.allValue, "'__all__'");
    assert.match(((v.query as Record<string, Record<string, string>>).azureLogAnalytics).query, new RegExp(`distinct ${col}`));
  }
});

test('every dashboard lands in the target folder, one file each', () => {
  const paths = buildAzure('/out', TARGET).map((a) => a.path);
  assert.ok(paths.includes('/out/ion/ion-cost.json'));
  assert.ok(paths.includes('/out/ion/ion-overview.json'));
  assert.ok(paths.every((p) => p.startsWith('/out/ion/')));
  assert.equal(new Set(paths).size, RECIPES.length);
});
