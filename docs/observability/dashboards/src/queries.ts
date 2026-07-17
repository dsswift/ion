// Canonical query-builder primitives.
//
// Every LogQL expression in the dashboards is constructed through one of these
// helpers so that (a) the same calculation is defined exactly once, and (b) the
// query CLASS travels with the expression. The class is what the panel builders
// enforce and what the structural overcount audit re-checks against emitted
// JSON. See types.ts for the taxonomy.
//
// The registry (registerQuery) records every NAMED query so generate.ts can
// emit queries.md straight from the module — docs cannot drift from panels.

import type { Expr, QueryClass, Window } from './types.ts';

// ---------------------------------------------------------------------------
// Named-query registry (feeds the generated queries.md)
// ---------------------------------------------------------------------------

export interface RegisteredQuery {
  readonly name: string;
  readonly cls: QueryClass;
  readonly expr: string;
  readonly window: Window | null;
  readonly commentary: string;
}

const REGISTRY: RegisteredQuery[] = [];

// Register a query for the generated reference doc. Returns the Expr unchanged
// so call sites can `return register('name', 'commentary', builder(...))`.
export function registerQuery(name: string, commentary: string, e: Expr): Expr {
  REGISTRY.push({ name, cls: e.cls, expr: e.expr, window: e.window, commentary });
  return e;
}

export function registeredQueries(): readonly RegisteredQuery[] {
  return REGISTRY;
}

// ---------------------------------------------------------------------------
// Low-level constructors
// ---------------------------------------------------------------------------

// A raw log-stream selector (no aggregation, no window). Used by logs panels,
// table panels that render raw lines, and annotation queries.
export function stream(expr: string): Expr {
  return { expr, cls: 'instant', window: null };
}

// An accumulation: sum_over_time / count_over_time. The window decides validity
// on a range vs. instant target — enforced downstream by the panel builder, not
// here (the same Expr is legitimately used on an instant stat with a fixed
// window and on a timeseries with $__interval).
export function accumulation(expr: string, window: Window): Expr {
  return { expr, cls: 'accumulation', window };
}

// A windowed statistic: quantile/avg/max/last_over_time, or a deliberately
// rolling count. A fixed window here is legitimate on any target. Set
// `pinWindow` for rolling COUNTS whose window is part of the panel's stated
// meaning (the "(5m)"/"(1m)" panels), so the builder enforces title/window
// agreement. Leave it unset for statistical smoothing windows.
export function windowedStat(expr: string, window: Window, pinWindow = false): Expr {
  return { expr, cls: 'windowed-stat', window, pinWindow };
}

// An instant snapshot expression (ranked/pie/table), evaluated once.
export function instant(expr: string, window: Window | null): Expr {
  return { expr, cls: 'instant', window };
}

// ---------------------------------------------------------------------------
// Shared LogQL fragment helpers
// ---------------------------------------------------------------------------

// The telemetry stream selector for a given event kind.
// Uses service_name because:
//   - Cluster OTLP path: otelcol.exporter.loki promotes resource service.name
//     as service_name (dot → underscore conversion is automatic and cannot be
//     suppressed in the exporter). The loki.process stage cannot rename it.
//   - Local file-tail path: path_targets sets both service and service_name
//     so both stacks emit service_name for the telemetry stream.
// Dashboards targeting both stacks must use service_name.
export function telemetry(kind: string): string {
  return `{service_name="ion-telemetry", kind="${kind}"}`;
}

// Coalesce an empty/absent `context_extension` into the literal "unattributed"
// bucket, applied at the STREAM level (before aggregation) via `label_format`.
//
// Why not `label_replace(..., "^$")`: Loki drops a label whose parsed value is
// empty, so a run with no `context.extension` produces a series where
// context_extension is ABSENT, not "". `label_replace` matching "^$" on an
// ABSENT source label is not a behavior Loki guarantees across versions and
// shard-merge boundaries — the coalesce silently no-ops in exactly the
// unattributed case it exists to handle, and the pie renders a nameless
// "Value #A" slice. Coalescing on the stream with a Go-template default
// guarantees the label is PRESENT and non-empty on every entry before
// `sum by (context_extension)` runs, so the aggregated series always carries a
// real value ("unattributed" or the extension name). `injectExpr` is spliced
// into the pipeline immediately before the range-vector selector.
export function coalesceUnattributed(inner: string): string {
  return coalesceLabel(inner, 'context_extension', 'unattributed');
}

// Generalised coalesce: guarantee `label` is PRESENT and non-empty on every
// entry before aggregation, substituting `fallback` when the parsed value is
// absent/empty. Same rationale as coalesceUnattributed (which now delegates
// here); also used to coalesce the enterprise-only `user` field into the
// "unassigned" bucket on default installs.
export function coalesceLabel(inner: string, label: string, fallback: string): string {
  return injectExpr(inner, coalesceStage(label, fallback));
}

// The bare coalesce pipeline stage, for callers that compose their own stream
// pipe (e.g. a coalesce that must run BEFORE a variable filter, so the fallback
// bucket is itself selectable — the users pack's `user=~"$user"` case).
export function coalesceStage(label: string, fallback: string): string {
  return `| label_format ${label}=\`{{if .${label}}}{{.${label}}}{{else}}${fallback}{{end}}\``;
}

// Splice a stream stage into a LogQL expression immediately before the range
// selector's `| unwrap`, or before the closing `[window])` when there is no
// unwrap. Keeps the coalesce inside the log-stream pipeline (where label_format
// is legal) rather than on the aggregated instant vector (where it is not).
function injectExpr(inner: string, stage: string): string {
  const unwrapIdx = inner.lastIndexOf('| unwrap');
  if (unwrapIdx !== -1) {
    return `${inner.slice(0, unwrapIdx)}${stage} ${inner.slice(unwrapIdx)}`;
  }
  // No unwrap: inject before the range selector `[...]`.
  const rangeIdx = inner.lastIndexOf('[');
  return `${inner.slice(0, rangeIdx)}${stage} ${inner.slice(rangeIdx)}`;
}

// label_replace that derives a conditional version suffix ("vsuffix") from
// context_extension_version: " v<version>" when a version exists, empty when it
// does not. Paired with legend `{{context_extension}}{{vsuffix}}` so extensions
// without a manifest version render as a bare name (no trailing "v").
export function versionSuffix(inner: string): string {
  return `label_replace(${inner}, "vsuffix", " v$1", "context_extension_version", "(.+)")`;
}
