// Loki dashboard JSON -> Azure Monitor dashboard JSON.
//
// Input is exactly what buildDashboard() emits for the local stack, so every
// panel, layout, threshold, link, and transformation carries over unchanged.
// Only the data plumbing is rewritten: data sources, targets (LogQL compiled to
// KQL), the Device/User variables, and annotations. A construct with no KQL
// form throws, naming the dashboard and panel, instead of being dropped.

import { compileMetric, compileStream, ALL_VALUE, type CompileOptions, type Mode } from './compile.ts';
import { isStreamQuery, parseLogQuery, parseMetric } from './logql.ts';
import { kqlString, VIEW, type Scope } from './fields.ts';
import { withViews, type AzureTarget } from './target.ts';
import { azureText, unusedSwaps } from './text.ts';

type Json = Record<string, unknown>;

const QUERY_TYPE = 'Azure Log Analytics';

interface Ctx {
  readonly target: AzureTarget;
  readonly multiVars: ReadonlySet<string>;
  readonly uid: string;
}

function laTarget(ctx: Ctx, refId: string, query: string, resultFormat: string): Json {
  return {
    refId,
    datasource: ctx.target.datasource,
    queryType: QUERY_TYPE,
    azureLogAnalytics: {
      query: withViews(ctx.target, query),
      resources: ctx.target.resources,
      resultFormat,
      dashboardTime: false,
    },
  };
}

// `{{payload_model}} x` -> `${__field.labels.payload_model} x`.
function legendTemplate(legend: string): string {
  return legend.replace(/\{\{\s*(\w+)\s*\}\}/g, '${__field.labels.$1}');
}

function colName(name: string): string {
  return /^[A-Za-z_]\w*$/.test(name) ? name : `[${kqlString(name)}]`;
}

// The newest matching lines, shaped for a logs panel or a raw-row table.
function streamQuery(expr: string, forTable: boolean, opts: CompileOptions): string {
  const { query, scope } = compileStream(parseLogQuery(expr), opts);
  if (!forTable) {
    const level = scope.family === 'logs' ? ', level' : '';
    return `${query}\n| project TimeGenerated, body${level}`;
  }
  return `${query}\n${flattenLabels(scope)}\n| project TimeGenerated, labels, Line = body`;
}

// Loki hands a raw-row table a `labels` object of flattened keys
// (payload_model, context_session_id); the panels' extractFields read it.
function flattenLabels(scope: Scope): string {
  if (scope.family === 'telemetry') {
    const prefixed = (bag: string, out: string) =>
      `| mv-apply _k = bag_keys(${bag}) to typeof(string) on (summarize ${out} = make_bag(bag_pack(strcat("${bag}_", _k), ${bag}[_k])))`;
    return [
      prefixed('payload', '_p'),
      prefixed('context', '_c'),
      '| extend labels = bag_merge(bag_pack("event_name", event_name, "service_name", ServiceName, "service_instance_id", ServiceInstanceId, "service_version", ServiceVersion, "host_name", host_name, "user", user, "trace_id", TraceId, "span_id", SpanId), _p, _c)',
    ].join('\n');
  }
  return [
    '| mv-apply _k = bag_keys(fields) to typeof(string) on (summarize _f = make_bag(bag_pack(strcat("fields_", _k), fields[_k])))',
    '| extend labels = bag_merge(bag_pack("level", level, "service_name", ServiceName, "tag", tag, "msg", msg, "host_name", host_name, "user", user, "session_id", session_id, "conversation_id", conversation_id, "trace_id", TraceId, "span_id", SpanId), _f)',
  ].join('\n');
}

function convertTargets(panel: Json, ctx: Ctx): { targets: Json[]; overrides: Json[] } {
  const loki = (panel.targets as Json[]) ?? [];
  const isTable = panel.type === 'table';
  const overrides: Json[] = [];
  const targets = loki.map((t) => {
    const refId = t.refId as string;
    const expr = t.expr as string;
    const mode = t.queryType as Mode;
    const opts: CompileOptions = { mode, multiVars: ctx.multiVars };
    const where = `${ctx.uid} / "${panel.title as string}" / ${refId}`;
    try {
      if (isStreamQuery(expr)) {
        return laTarget(ctx, refId, streamQuery(expr, isTable, opts), isTable ? 'table' : 'logs');
      }
      const c = compileMetric(parseMetric(expr), opts);
      const legend = t.legendFormat as string | undefined;
      const dynamic = !!legend && /\{\{/.test(legend);
      let value = 'Value';
      if (isTable && mode === 'instant') value = loki.length > 1 ? `Value #${refId}` : 'Value';
      else if (legend && !dynamic) value = legend;
      if (!isTable && dynamic) {
        overrides.push({
          matcher: { id: 'byFrameRefID', options: refId },
          properties: [{ id: 'displayName', value: legendTemplate(legend) }],
        });
      }
      const labels = c.labels.map(colName);
      const tableOut = isTable && mode === 'instant';
      const time = tableOut ? [] : ['TimeGenerated'];
      const stamp = mode === 'instant' && !tableOut ? '\n| extend TimeGenerated = $__timeTo()' : '';
      const query = `${c.query}${stamp}\n| project ${[...time, ...labels, `${colName(value)} = Value`].join(', ')}`;
      return laTarget(ctx, refId, query, tableOut ? 'table' : 'time_series');
    } catch (err) {
      throw new Error(`${where}: ${(err as Error).message}`);
    }
  });
  return { targets, overrides };
}

// TraceQL `{ .attr = "v" && name = "v" }` -> the matching spans as a table.
// Grafana cannot draw a trace tree from Log Analytics rows; Application
// Insights is the trace-tree surface in Azure, keyed by the same TraceId.
function tracesToTable(panel: Json, ctx: Ctx): Json {
  const tq = ((panel.targets as Json[])[0].query as string).trim();
  const body = /^\{(.*)\}$/.exec(tq)?.[1];
  if (!body) throw new Error(`${ctx.uid} / "${panel.title as string}": unsupported TraceQL ${tq}`);
  const conds = body.split('&&').map((c) => {
    const m = /^\s*(\.?)(\w+)\s*=\s*"([^"]*)"\s*$/.exec(c);
    if (!m) throw new Error(`${ctx.uid} / "${panel.title as string}": unsupported TraceQL condition ${c}`);
    // TraceQL intrinsics and the span view's scalar columns; any other
    // attribute reads the span's attributes bag.
    const columns: Record<string, string> = {
      name: 'Name', session_id: 'session_id', conversation_id: 'conversation_id', user: 'user', host_name: 'host_name',
    };
    const col = columns[m[2]] ?? `tostring(attributes[${kqlString(m[2])}])`;
    return `| where ${col} == ${kqlString(m[3])}`;
  });
  const query = [
    VIEW.spans,
    '| where $__timeFilter(TimeGenerated)',
    ...conds,
    '| project TimeGenerated, Name, TraceId, SpanId, ParentSpanId, DurationMs, ServiceName, attributes',
    '| order by TimeGenerated asc',
  ].join('\n');
  const description =
    `${(panel.description as string | undefined) ?? ''} In Azure this lists the matching spans; open a TraceId in ` +
    'Application Insights (Transaction search) for the parent/child tree.';
  return {
    ...panel,
    type: 'table',
    description: description.trim(),
    datasource: ctx.target.datasource,
    targets: [laTarget(ctx, 'A', query, 'table')],
  };
}

function convertPanel(panel: Json, ctx: Ctx): Json {
  if (panel.type === 'row') return { ...panel, panels: ((panel.panels as Json[]) ?? []).map((p) => convertPanel(p, ctx)) };
  if (panel.type === 'text') {
    const options = panel.options as Json;
    return { ...panel, options: { ...options, content: azureText(ctx.uid, options.content as string) } };
  }
  if (panel.type === 'traces') return tracesToTable(panel, ctx);
  if (!Array.isArray(panel.targets)) return { ...panel, datasource: ctx.target.datasource };
  const { targets, overrides } = convertTargets(panel, ctx);
  const out: Json = { ...panel, datasource: ctx.target.datasource, targets };
  if (overrides.length) {
    const fc = (panel.fieldConfig as Json | undefined) ?? { defaults: {}, overrides: [] };
    out.fieldConfig = { ...fc, overrides: [...((fc.overrides as Json[]) ?? []), ...overrides] };
  }
  return out;
}

// The Device and User dropdowns: distinct values across both views, of the
// label the Loki variable lists (`label_values(host_name)` -> host_name).
function identityVar(v: Json, ctx: Ctx): Json {
  const col = /label_values\((\w+)\)/.exec(String(v.query))?.[1] ?? (v.name as string);
  const query = [
    `union ${VIEW.telemetry}, ${VIEW.logs}`,
    '| where $__timeFilter(TimeGenerated)',
    `| where isnotempty(${col})`,
    `| distinct ${col}`,
    `| order by ${col} asc`,
  ].join('\n');
  return {
    ...v,
    datasource: ctx.target.datasource,
    query: laTarget(ctx, 'A', query, 'table'),
    allValue: ALL_VALUE,
    sort: 1,
  };
}

function convertAnnotation(a: Json, ctx: Ctx): Json {
  const expr = (a.expr ?? a.rawQuery) as string;
  const q = parseLogQuery(expr);
  const { query, scope } = compileStream(q, { mode: 'range', multiVars: ctx.multiVars });
  const parts = (a.titleFormat as string).split(/(\{\{\s*\w+\s*\}\})/).filter((s) => s !== '');
  const text = parts.map((s) => {
    const m = /^\{\{\s*(\w+)\s*\}\}$/.exec(s);
    return m ? scope.str(m[1]) : kqlString(s);
  });
  return {
    datasource: ctx.target.datasource,
    enable: a.enable,
    hide: a.hide,
    iconColor: a.iconColor,
    name: a.name,
    target: laTarget(ctx, 'Anno', `${query}\n| project TimeGenerated, text = strcat(${text.join(', ')})`, 'table'),
  };
}

function textContents(panels: readonly Json[]): string[] {
  return panels.flatMap((p) =>
    p.type === 'row' ? textContents((p.panels as Json[]) ?? []) : p.type === 'text' ? [(p.options as Json).content as string] : [],
  );
}

/** Convert one built Loki dashboard into its Azure Monitor twin. */
export function toAzure(loki: Json, target: AzureTarget): Json {
  const uid = loki.uid as string;
  const vars = ((loki.templating as Json).list as Json[]) ?? [];
  const multiVars = new Set(vars.filter((v) => v.type === 'query' && v.multi === true).map((v) => v.name as string));
  const ctx: Ctx = { target, multiVars, uid };
  const stale = unusedSwaps(uid, textContents(loki.panels as Json[]));
  if (stale.length) throw new Error(`${uid}: text swaps no longer match any panel: ${stale.join(' | ')}`);
  return {
    ...loki,
    annotations: { list: (((loki.annotations as Json).list as Json[]) ?? []).map((a) => convertAnnotation(a, ctx)) },
    panels: (loki.panels as Json[]).map((p) => convertPanel(p, ctx)),
    templating: { list: vars.map((v) => (multiVars.has(v.name as string) ? identityVar(v, ctx) : v)) },
  };
}
