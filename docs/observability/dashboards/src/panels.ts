// Class-enforcing panel builders.
//
// These are the mechanism that makes the timeseries-overcount bug UNWRITABLE.
// Each builder knows its evaluation mode (instant vs. range) and validates every
// target's query class against it before emitting JSON:
//
//   * A range/series panel (timeseries, barchart, heatmap) with an ACCUMULATION
//     target MUST use `$__interval`. A fixed window throws — that is the exact
//     $7.26K-against-$255 defect, now impossible to construct.
//   * An instant panel (stat, bargauge, piechart, gauge) with an ACCUMULATION
//     target must NOT use `$__interval` (there is no per-step interval to bind);
//     it uses a fixed window or `$__range`.
//   * A WINDOWED-STAT target may carry a fixed rolling window on any panel; on a
//     series panel the builder pins that window into the title so a title/window
//     mismatch is impossible.
//
// Every emitted target is stamped with `__ionClass`. Grafana ignores the extra
// key; the structural overcount audit in check.ts reads it to re-verify, purely
// from emitted JSON, that no range-target accumulation carries a fixed window —
// belt-and-suspenders against a raw-JSON escape hatch. It is the only way a
// pure-JSON audit can tell an overcount accumulation apart from a legitimate
// rolling count (identical LogQL, different intent).

import type { Expr, FixedWindow } from './types.ts';
import { LOKI, TEMPO, isFixedWindow } from './types.ts';

export type EvalMode = 'instant' | 'range';

export interface GridPos {
  readonly h: number;
  readonly w: number;
  readonly x: number;
  readonly y: number;
}

// One target on a panel. `e` carries the expression + class + window.
export interface Target {
  readonly e: Expr;
  readonly legend?: string;
  readonly refId?: string;
}

// The emitted target shape. `__ionClass` is the audit hook.
interface EmittedTarget {
  datasource: typeof LOKI;
  expr: string;
  legendFormat?: string;
  queryType: EvalMode;
  refId: string;
  __ionClass: Expr['cls'];
}

const REF_IDS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Validate a single target against the panel's evaluation mode and emit it.
function emitTarget(t: Target, mode: EvalMode, index: number, panelTitle: string): EmittedTarget {
  const { e } = t;

  // The overcount guard. An accumulation summed per step must bind to the panel
  // step (`$__interval`); a fixed window re-sums the whole window at every step.
  if (mode === 'range' && e.cls === 'accumulation' && isFixedWindow(e.window)) {
    throw new Error(
      `overcount: panel "${panelTitle}" target ${index} is an accumulation on a range ` +
        `panel with fixed window [${e.window}]. Range accumulations must use $__interval. ` +
        `Expr: ${e.expr}`,
    );
  }

  // The inverse: an instant panel has no per-step interval to bind.
  if (mode === 'instant' && e.cls === 'accumulation' && e.window === '$__interval') {
    throw new Error(
      `invalid: panel "${panelTitle}" target ${index} is an accumulation on an instant ` +
        `panel using $__interval. Instant accumulations need a fixed window or $__range. ` +
        `Expr: ${e.expr}`,
    );
  }

  const out: EmittedTarget = {
    datasource: LOKI,
    expr: e.expr,
    queryType: mode,
    refId: t.refId ?? REF_IDS[index],
    __ionClass: e.cls,
  };
  if (t.legend !== undefined) out.legendFormat = t.legend;
  return out;
}

// For a series panel, pin every ROLLING-COUNT windowed-stat's fixed window into
// the title so a title/window mismatch is impossible (the "(5m)" / "(1m)" rule).
// Only targets that explicitly opt in via `pinWindow` are checked — statistical
// windows (rate/quantile/avg) conventionally omit the window from the title.
function assertWindowInTitle(targets: readonly Target[], title: string): void {
  for (const t of targets) {
    if (t.e.cls === 'windowed-stat' && t.e.pinWindow && isFixedWindow(t.e.window)) {
      const w = t.e.window as FixedWindow;
      if (!title.includes(w)) {
        throw new Error(
          `window/title drift: series panel "${title}" has a windowed-stat target with ` +
            `fixed window [${w}] but the title does not mention "${w}". Pin the window in the title.`,
        );
      }
    }
  }
}

// Shared panel scaffold fields.
interface PanelBase {
  id: number;
  title: string;
  gridPos: GridPos;
  description?: string;
  fieldConfig?: unknown;
  options?: unknown;
  transformations?: unknown;
}

function base(p: PanelBase, type: string): Record<string, unknown> {
  const out: Record<string, unknown> = { id: p.id, type, title: p.title, gridPos: p.gridPos };
  if (p.description !== undefined) out.description = p.description;
  return out;
}

// ---------------------------------------------------------------------------
// Structural panels
// ---------------------------------------------------------------------------

export function row(id: number, title: string, y: number): Record<string, unknown> {
  return {
    id,
    type: 'row',
    title,
    gridPos: { h: 1, w: 24, x: 0, y },
    collapsed: false,
    panels: [],
  };
}

export function text(id: number, gridPos: GridPos, content: string, title = ''): Record<string, unknown> {
  return {
    id,
    type: 'text',
    title,
    gridPos,
    options: { mode: 'markdown', content },
    datasource: null,
  };
}

// ---------------------------------------------------------------------------
// Instant panels (force instant evaluation)
// ---------------------------------------------------------------------------

interface InstantPanelSpec extends PanelBase {
  targets: readonly Target[];
}

function instantPanel(type: string, p: InstantPanelSpec): Record<string, unknown> {
  const out = base(p, type);
  out.datasource = LOKI;
  if (p.fieldConfig !== undefined) out.fieldConfig = p.fieldConfig;
  if (p.options !== undefined) out.options = p.options;
  if (p.transformations !== undefined) out.transformations = p.transformations;
  out.targets = p.targets.map((t, i) => emitTarget(t, 'instant', i, p.title));
  return out;
}

export const stat = (p: InstantPanelSpec) => instantPanel('stat', p);
export const bargauge = (p: InstantPanelSpec) => instantPanel('bargauge', p);
export const piechart = (p: InstantPanelSpec) => instantPanel('piechart', p);
export const gauge = (p: InstantPanelSpec) => instantPanel('gauge', p);
export const barchart = (p: InstantPanelSpec) => instantPanel('barchart', p);

// ---------------------------------------------------------------------------
// Series panels (range evaluation, per-step)
// ---------------------------------------------------------------------------

interface SeriesPanelSpec extends PanelBase {
  targets: readonly Target[];
}

// Grafana derives a range query's step from the panel's pixel width unless
// maxDataPoints is pinned. On a wide dashboard time range (e.g. 30d) a narrow
// panel gets a coarse step, and Loki's count_over_time/sum_over_time stamps each
// bucket at a STEP-ALIGNED timestamp. When the real data occupies a short window
// and the step is coarse, the single populated bucket aligns to a timestamp
// PAST `now` — Grafana then discards it as "DATA OUTSIDE TIME RANGE" and the
// panel blanks, even though the data is squarely inside the range. Instant
// panels beside it are unaffected (they evaluate once over the whole range), so
// the failure looks like a trend-only, narrow-panel-only defect.
//
// Pinning maxDataPoints forces a fine step regardless of panel width: step =
// range / maxDataPoints. At 2000 the 30d step is ~1296s, small enough that
// populated buckets always land at or before `now`. On short ranges Loki floors
// the step to its own minimum (~30s), so this never over-granularizes or adds
// query load. This is the Grafana mechanism that governs step; it is the direct
// fix for the out-of-range bucket, not a heuristic.
const SERIES_MAX_DATA_POINTS = 2000;

function seriesPanel(type: string, p: SeriesPanelSpec): Record<string, unknown> {
  assertWindowInTitle(p.targets, p.title);
  const out = base(p, type);
  out.datasource = LOKI;
  out.maxDataPoints = SERIES_MAX_DATA_POINTS;
  if (p.fieldConfig !== undefined) out.fieldConfig = p.fieldConfig;
  if (p.options !== undefined) out.options = p.options;
  if (p.transformations !== undefined) out.transformations = p.transformations;
  out.targets = p.targets.map((t, i) => emitTarget(t, 'range', i, p.title));
  return out;
}

export const timeseries = (p: SeriesPanelSpec) => seriesPanel('timeseries', p);
export const heatmap = (p: SeriesPanelSpec) => seriesPanel('heatmap', p);

// ---------------------------------------------------------------------------
// Raw / mixed panels
// ---------------------------------------------------------------------------

// Logs panels render raw stream lines; always range-evaluated.
interface LogsPanelSpec extends PanelBase {
  target: Target;
  options?: unknown;
}
export function logs(p: LogsPanelSpec): Record<string, unknown> {
  const out = base(p, 'logs');
  out.datasource = LOKI;
  out.options = p.options ?? {
    showTime: true,
    showLabels: false,
    showCommonLabels: false,
    wrapLogMessage: true,
    prettifyLogMessage: true,
    enableLogDetails: true,
    dedupStrategy: 'none',
    sortOrder: 'Descending',
  };
  out.targets = [emitTarget(p.target, 'range', 0, p.title)];
  return out;
}

// Tables may be instant (aggregation) or range (raw lines); the recipe declares
// which. Class enforcement still applies via the chosen mode.
interface TablePanelSpec extends PanelBase {
  targets: readonly Target[];
  mode: EvalMode;
}
export function table(p: TablePanelSpec): Record<string, unknown> {
  const out = base(p, 'table');
  out.datasource = LOKI;
  if (p.fieldConfig !== undefined) out.fieldConfig = p.fieldConfig;
  if (p.options !== undefined) out.options = p.options;
  if (p.transformations !== undefined) out.transformations = p.transformations;
  out.targets = p.targets.map((t, i) => emitTarget(t, p.mode, i, p.title));
  return out;
}

// Tempo trace panel (forensics dispatch tree). Not a LogQL/class target.
interface TracesPanelSpec extends PanelBase {
  query: string;
}
export function traces(p: TracesPanelSpec): Record<string, unknown> {
  const out = base(p, 'traces');
  out.datasource = TEMPO;
  if (p.fieldConfig !== undefined) out.fieldConfig = p.fieldConfig;
  out.options = p.options ?? {};
  out.targets = [{ datasource: TEMPO, queryType: 'traceql', query: p.query, refId: 'A' }];
  return out;
}

// Escape hatch for genuinely bespoke panels the typed builders do not cover.
// Still passes class validation: any embedded targets are validated in `mode`.
interface EscapeHatchSpec extends PanelBase {
  type: string;
  targets?: readonly Target[];
  mode?: EvalMode;
  extra?: Record<string, unknown>;
}
export function escapeHatch(p: EscapeHatchSpec): Record<string, unknown> {
  const out = base(p, p.type);
  out.datasource = LOKI;
  if (p.fieldConfig !== undefined) out.fieldConfig = p.fieldConfig;
  if (p.options !== undefined) out.options = p.options;
  if (p.transformations !== undefined) out.transformations = p.transformations;
  if (p.targets) {
    const mode = p.mode ?? 'range';
    out.targets = p.targets.map((t, i) => emitTarget(t, mode, i, p.title));
  }
  if (p.extra) Object.assign(out, p.extra);
  return out;
}
