// LogQL (the recipe subset) to KQL over the Ion views.
//
// A compiled metric is a tabular KQL pipeline whose rows are the Loki series:
// one string column per label, a `Value` column, and in range mode a
// `TimeGenerated` bucket column. Aggregations, binary operators, and
// label_replace compose those tables the way PromQL composes vectors.
//
// Time follows the query class the recipes already declare:
//   * range, `$__interval` window  -> bin(TimeGenerated, $__interval)
//   * range, fixed window W         -> bin(TimeGenerated, max_of(W, $__interval)); counts
//     and sums scale to W so a point still reads "per W", as the rolling window did
//   * instant, `$__range`           -> the dashboard range
//   * instant, fixed window W       -> the W before the dashboard's end, as Loki evaluates it

import type { AggOp, LogQuery, Matcher, Node, RangeFn } from './logql.ts';
import { Scope, VIEW, familyOf, isLogsOnlyMatcher, kqlString, type Family } from './fields.ts';

export type Mode = 'range' | 'instant';

export interface Compiled {
  readonly query: string;
  readonly labels: readonly string[];
  readonly views: ReadonlySet<Family>;
}

interface Frag {
  readonly q: string;
  readonly labels: readonly string[];
}

// Template variables whose values are a multi-select list rather than a regex.
// The identity dropdowns send `__all__` for All so an unlabeled line still shows.
export const ALL_SENTINEL = '__all__';

// Grafana substitutes a variable's custom allValue verbatim, skipping the
// `:singlequote` format a query asks for, so the allValue carries its own
// quotes to read as the same KQL string literal a selected value becomes.
export const ALL_VALUE = `'${ALL_SENTINEL}'`;

export interface CompileOptions {
  readonly mode: Mode;
  readonly multiVars: ReadonlySet<string>;
}

const TIME_FILTER = '$__timeFilter(TimeGenerated)';
const TO = '$__timeTo()';
const EPOCH_TO = `((${TO} - datetime(1970-01-01)) / 1s)`;

function timespan(w: string): string {
  if (!/^\d+[smhd]$/.test(w)) throw new Error(`not a fixed window: ${w}`);
  return w;
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

function varOf(value: string): string | null {
  const m = /^\$(\w+)$|^\$\{(\w+)\}$/.exec(value);
  return m ? (m[1] ?? m[2]) : null;
}

function predicate(expr: string, op: Matcher['op'], value: string, opts: CompileOptions): string {
  const v = varOf(value);
  if (v && opts.multiVars.has(v) && (op === '=~' || op === '=')) {
    return `(${expr} in (\${${v}:singlequote}) or ${kqlString(ALL_SENTINEL)} in (\${${v}:singlequote}))`;
  }
  switch (op) {
    case '=':
      return `${expr} == ${kqlString(value)}`;
    case '!=':
      return value === '' ? `isnotempty(${expr})` : `${expr} != ${kqlString(value)}`;
    case '=~':
      return value === '.*' ? 'true' : `${expr} matches regex ${kqlString(`^(?:${value})$`)}`;
    case '!~':
      return `not(${expr} matches regex ${kqlString(`^(?:${value})$`)})`;
  }
}

// ---------------------------------------------------------------------------
// Log pipeline (selector + stages) -> filtered rows, plus the unwrapped value
// ---------------------------------------------------------------------------

interface Pipeline {
  readonly scope: Scope;
  readonly lines: string[];
  readonly unwrap: string | null;
}

function pipeline(q: LogQuery, timeClause: string, opts: CompileOptions): Pipeline {
  const family = familyOf(q.matchers);
  const scope = new Scope(family);
  const lines = [VIEW[family], `| where ${timeClause}`];
  const where = (p: string) => {
    if (p !== 'true') lines.push(`| where ${p}`);
  };
  for (const m of q.matchers) {
    if (isLogsOnlyMatcher(m)) continue;
    where(predicate(scope.str(m.name), m.op, m.value, opts));
  }
  let unwrap: string | null = null;
  for (const s of q.stages) {
    switch (s.kind) {
      case 'json':
        for (const [alias, path] of Object.entries(s.params)) scope.alias(alias, path);
        break;
      case 'noerror':
        break;
      case 'filter':
        where(predicate(scope.str(s.name), s.op, s.value, opts));
        break;
      case 'coalesce': {
        const cur = scope.str(s.name);
        lines.push(`| extend ${s.name} = iff(isempty(${cur}), ${kqlString(s.fallback)}, ${cur})`);
        scope.defineLocal(s.name);
        break;
      }
      case 'timestamp':
        lines.push(`| extend ${s.name} = (TimeGenerated - datetime(1970-01-01)) / 1s`);
        scope.defineLocal(s.name);
        break;
      case 'unwrap':
        unwrap = scope.num(s.name);
        break;
    }
  }
  if (unwrap) {
    lines.push(`| extend _v = ${unwrap}`, '| where isnotnull(_v)');
  }
  return { scope, lines, unwrap };
}

// ---------------------------------------------------------------------------
// Range functions, fused with the aggregation directly around them
// ---------------------------------------------------------------------------

// How an outer aggregation combines a range function's per-series results. For
// these pairs the combination is the same statistic over all matching lines.
function fusedAgg(fn: RangeFn, outer: AggOp | null, param?: number): string | null {
  const v = '_v';
  if (fn === 'count_over_time' && (outer === 'sum' || outer === 'count' || outer === null)) return 'count()';
  if (fn === 'rate' && (outer === 'sum' || outer === null)) return 'count()';
  if (fn === 'sum_over_time' && (outer === 'sum' || outer === null)) return `sum(${v})`;
  if (fn === 'avg_over_time' && (outer === 'avg' || outer === null)) return `avg(${v})`;
  if (fn === 'max_over_time' && (outer === 'max' || outer === null)) return `max(${v})`;
  if (fn === 'min_over_time' && (outer === 'min' || outer === null)) return `min(${v})`;
  // Each | json line is its own Loki series, so last-per-series under max is the max line.
  if (fn === 'last_over_time' && outer === 'max') return `max(${v})`;
  if (fn === 'last_over_time' && outer === null) return 'arg_max(_t, _v)';
  if (fn === 'quantile_over_time' && outer === null) return `percentile(${v}, ${(param ?? 0.5) * 100})`;
  return null;
}

function range(
  node: Extract<Node, { t: 'range' }>,
  outer: AggOp | null,
  by: readonly string[],
  opts: CompileOptions,
): Frag {
  const agg = fusedAgg(node.fn, outer, node.param);
  if (!agg) throw new Error(`cannot combine ${outer}(${node.fn}) in KQL`);
  const fixed = node.window !== '$__interval' && node.window !== '$__range';
  let timeClause = TIME_FILTER;
  if (opts.mode === 'instant' && fixed) {
    timeClause = `TimeGenerated > ${TO} - ${timespan(node.window)} and TimeGenerated <= ${TO}`;
  }
  const p = pipeline(node.q, timeClause, opts);
  const keys = by.map((l) => (p.scope.str(l) === l ? l : `${l} = ${p.scope.str(l)}`));
  const lines = [...p.lines];
  // Latest value per group: arg_max keeps the newest line's value, then it becomes Value.
  const latest = agg.startsWith('arg_max');
  if (latest) lines.push('| extend _t = TimeGenerated');
  const summarize = (by: string) =>
    latest
      ? `| summarize ${agg}${by}\n| project-away _t\n| project-rename Value = _v`
      : `| summarize Value = ${agg}${by}`;
  if (opts.mode === 'range') {
    const bucket = fixed ? `max_of(${timespan(node.window)}, $__interval)` : '$__interval';
    lines.push(summarize(` by TimeGenerated = bin(TimeGenerated, ${bucket})${keys.map((k) => `, ${k}`).join('')}`));
    if (node.fn === 'rate') lines.push(`| extend Value = todouble(Value) / (${bucket} / 1s)`);
    else if (fixed && (node.fn === 'count_over_time' || node.fn === 'sum_over_time')) {
      lines.push(`| extend Value = todouble(Value) * (${timespan(node.window)} / ${bucket})`);
    }
  } else {
    lines.push(summarize(keys.length ? ` by ${keys.join(', ')}` : ''));
    if (node.fn === 'rate') {
      const secs = fixed ? `(${timespan(node.window)} / 1s)` : `(($__timeTo() - $__timeFrom()) / 1s)`;
      lines.push(`| extend Value = todouble(Value) / ${secs}`);
    }
  }
  return { q: lines.join('\n'), labels: by };
}

// ---------------------------------------------------------------------------
// Vector composition
// ---------------------------------------------------------------------------

function keyCols(labels: readonly string[], mode: Mode): string[] {
  return mode === 'range' ? ['TimeGenerated', ...labels] : [...labels];
}

function aggregate(f: Frag, op: AggOp, by: readonly string[], param: number | undefined, mode: Mode): Frag {
  for (const l of by) if (!f.labels.includes(l)) throw new Error(`aggregation by "${l}" over a vector without it`);
  if (op === 'topk') {
    if (mode === 'range') throw new Error('topk on a range panel is not supported');
    return { q: `${f.q}\n| top ${param ?? 10} by Value desc`, labels: f.labels };
  }
  const fn = op === 'count' ? 'count()' : `${op}(Value)`;
  const keys = keyCols(by, mode);
  return { q: `${f.q}\n| summarize Value = ${fn}${keys.length ? ` by ${keys.join(', ')}` : ''}`, labels: by };
}

function compileVec(n: Node, opts: CompileOptions): Frag | number | 'now' {
  switch (n.t) {
    case 'num':
      return n.v;
    case 'now':
      return 'now';
    case 'range':
      return range(n, null, n.by ?? [], opts);
    case 'agg': {
      const by = n.by ?? [];
      if (n.arg.t === 'range' && !n.arg.by && n.op !== 'topk') return range(n.arg, n.op, by, opts);
      const inner = compileVec(n.arg, opts);
      if (typeof inner !== 'object') throw new Error(`${n.op}() over a scalar`);
      return aggregate(inner, n.op, by, n.param, opts.mode);
    }
    case 'label_replace': {
      const inner = compileVec(n.arg, opts);
      if (typeof inner !== 'object') throw new Error('label_replace over a scalar');
      const re = kqlString(`^(?:${n.regex})$`);
      const repl = kqlString(n.repl.replace(/\$(\d)/g, '\\$1'));
      const fallback = inner.labels.includes(n.dst) ? n.dst : '""';
      const q = `${inner.q}\n| extend ${n.dst} = iff(${n.src} matches regex ${re}, replace_regex(${n.src}, ${re}, ${repl}), ${fallback})`;
      return { q, labels: inner.labels.includes(n.dst) ? inner.labels : [...inner.labels, n.dst] };
    }
    case 'bin':
      return binary(n.op, compileVec(n.l, opts), compileVec(n.r, opts), opts.mode);
    case 'cmp': {
      const inner = compileVec(n.l, opts);
      if (typeof inner !== 'object') throw new Error('comparison over a scalar');
      return { q: `${inner.q}\n| where Value ${n.op} ${n.v}`, labels: inner.labels };
    }
  }
}

function binary(op: string, l: Frag | number | 'now', r: Frag | number | 'now', mode: Mode): Frag {
  const val = (x: number | 'now') => (x === 'now' ? EPOCH_TO : String(x));
  if (typeof l === 'object' && typeof r !== 'object') {
    return { q: `${l.q}\n| extend Value = todouble(Value) ${op} ${val(r)}`, labels: l.labels };
  }
  if (typeof r === 'object' && typeof l !== 'object') {
    return { q: `${r.q}\n| extend Value = ${val(l)} ${op} todouble(Value)`, labels: r.labels };
  }
  if (typeof l !== 'object' || typeof r !== 'object') throw new Error('binary operation between two scalars');
  const same = l.labels.length === r.labels.length && l.labels.every((x) => r.labels.includes(x));
  if (!same) throw new Error(`binary ${op} between vectors with labels [${l.labels}] and [${r.labels}]`);
  const keys = keyCols(l.labels, mode);
  const on = keys.length ? keys : ['_k'];
  const k = keys.length ? '' : '\n| extend _k = 1';
  const right = `${r.q}${k}\n| project ${[...on, '_r = todouble(Value)'].join(', ')}`;
  const q = `${l.q}${k}\n| join kind=inner (\n${indent(right)}\n) on ${on.join(', ')}\n| project ${[...keys, `Value = todouble(Value) ${op} _r`].join(', ')}`;
  return { q, labels: l.labels };
}

function indent(s: string): string {
  return s.split('\n').map((l) => `    ${l}`).join('\n');
}

function viewsIn(q: string): Set<Family> {
  const out = new Set<Family>();
  if (q.includes(VIEW.telemetry)) out.add('telemetry');
  if (q.includes(VIEW.logs)) out.add('logs');
  return out;
}

/** Compile a LogQL metric AST into a KQL table: label columns + Value (+ TimeGenerated in range mode). */
export function compileMetric(n: Node, opts: CompileOptions): Compiled {
  const out = compileVec(n, opts);
  if (typeof out !== 'object') throw new Error('a panel query must produce a vector, not a scalar');
  const order = opts.mode === 'range' ? '\n| order by TimeGenerated asc' : '';
  return { query: `${out.q}${order}`, labels: out.labels, views: viewsIn(out.q) };
}

/** Compile a bare stream query into its newest matching rows (logs panels, raw tables, annotations). */
export function compileStream(q: LogQuery, opts: CompileOptions): { query: string; scope: Scope; views: Set<Family> } {
  const p = pipeline(q, TIME_FILTER, opts);
  const query = [...p.lines, '| top 1000 by TimeGenerated desc'].join('\n');
  return { query, scope: p.scope, views: viewsIn(query) };
}
