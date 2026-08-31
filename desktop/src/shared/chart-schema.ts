/**
 * Chart Output contract — the versioned, strictly-validated shape the
 * `RenderChart` client tool accepts and the transcript renders.
 *
 * ── Why a strict schema instead of raw Chart.js options ─────────────────────
 * A chart's data lands in conversation history as the tool call's INPUT, which
 * the engine already persists and replays (`list_flatten.go` yields
 * `SessionMessage.ToolInput`). That makes this schema a DURABLE format: a chart
 * written today is parsed by a future Ion. Accepting arbitrary Chart.js config
 * would put a third-party library's evolving option tree — including function
 * callbacks that cannot survive JSON — into that durable record. So the model
 * supplies this stable Ion shape and the renderer maps it to Chart.js.
 *
 * ── Strict and versioned ────────────────────────────────────────────────────
 * Unknown fields are rejected rather than ignored. A silently-dropped field is
 * the worst outcome for a chart: the model believes it asked for a logarithmic
 * axis, the user sees a linear one, and nothing in the transcript says which
 * happened. `schemaVersion` is required so a future shape change is explicit
 * rather than inferred from field presence.
 *
 * ── Bounds exist to protect the model's own context window ──────────────────
 * The spec is part of the assistant turn, so every point stays in context
 * until compaction. 12 series x 120 points is the ceiling: enough for
 * multi-series monthly/weekly comparison, far below the token cost of a
 * daily-granularity multi-year dump.
 *
 * The strict parser that enforces all of the above lives next door in
 * `chart-parse.ts`; this module holds the durable shape and the pure value
 * helpers (cumulative totals, display formatting) that every renderer shares.
 */

/** Schema version every spec must declare. */
export const CHART_SCHEMA_VERSION = 1

/** Structural bounds. Rejections cite these numbers verbatim. */
export const CHART_LIMITS = {
  maxDatasets: 12,
  maxPoints: 120,
  maxTitleChars: 200,
  maxSubtitleChars: 500,
  maxCaptionChars: 500,
  maxSourceChars: 200,
  maxLabelChars: 60,
  maxAxisTitleChars: 80,
  maxSeriesLabelChars: 80,
  maxAnnotationLabelChars: 80,
  maxReferenceLines: 6,
  maxRangeBands: 4,
  maxDecimals: 6,
} as const

export type ChartKind = 'line' | 'area' | 'bar' | 'pie' | 'doughnut'
export type ChartSeriesKind = 'line' | 'bar'
export type ChartAxisScale = 'linear' | 'logarithmic'
export type ChartLineStyle = 'solid' | 'dashed' | 'dotted'
export type ChartAxisId = 'left' | 'right'
export type ChartLegendPosition = 'top' | 'bottom' | 'left' | 'right'
export type ChartValueFormatKind = 'decimal' | 'currency' | 'percent'

/** How a numeric axis (and anything bound to it) renders its values. */
export interface ChartValueFormat {
  kind: ChartValueFormatKind
  /** Decimal places, 0-6. Defaults to 0 for decimal/percent, 2 for currency. */
  decimals?: number
  /** ISO 4217 code, required for `currency` and rejected otherwise. */
  currency?: string
}

/** A numeric Y axis. `right` only exists when a dataset binds to it. */
export interface ChartValueAxis {
  title?: string
  scale?: ChartAxisScale
  min?: number
  max?: number
  format?: ChartValueFormat
}

/** The category (X) axis. Ion charts are category-based, never free numeric. */
export interface ChartCategoryAxis {
  title?: string
}

/** One data series. `null` is an explicit gap, never zero. */
export interface ChartDataset {
  label: string
  data: Array<number | null>
  /** `#RRGGBB`. Absent means the theme assigns one by series index. */
  color?: string
  /** Overrides the chart kind for this series (mixed bar + line charts). */
  kind?: ChartSeriesKind
  /** Which numeric axis this series is measured against. Defaults to `left`. */
  axis?: ChartAxisId
  /** Fill the area under a line series. */
  fill?: boolean
  style?: ChartLineStyle
  /**
   * Render the running total of `data` instead of the raw values. Ion computes
   * it so the model never has to supply pre-summed numbers it could get wrong.
   * A `null` source stays a gap; the carried total resumes at the next value.
   */
  cumulative?: boolean
}

/** A labelled horizontal line: a target, threshold, or average. */
export interface ChartReferenceLine {
  value: number
  label?: string
  color?: string
  axis?: ChartAxisId
  style?: ChartLineStyle
}

/** A labelled shaded band between two values on one axis. */
export interface ChartRangeBand {
  from: number
  to: number
  label?: string
  color?: string
  axis?: ChartAxisId
}

export interface ChartLegend {
  visible?: boolean
  position?: ChartLegendPosition
}

/** A fully validated chart. Every renderer reads exactly this. */
export interface ChartSpec {
  schemaVersion: typeof CHART_SCHEMA_VERSION
  kind: ChartKind
  title: string
  subtitle?: string
  caption?: string
  source?: string
  labels: string[]
  datasets: ChartDataset[]
  categoryAxis?: ChartCategoryAxis
  leftAxis?: ChartValueAxis
  rightAxis?: ChartValueAxis
  /** Explicit slice colors for pie/doughnut, one per label. */
  sliceColors?: string[]
  legend?: ChartLegend
  stacked?: boolean
  /** Print each value on the chart itself, not only in the tooltip. */
  showValues?: boolean
  referenceLines?: ChartReferenceLine[]
  rangeBands?: ChartRangeBand[]
}

/**
 * The tool-call envelope. `create` mints a new chart; `update` replaces one
 * chart's spec wholesale.
 *
 * Update carries BOTH the stable id and the chart's current title. The id is
 * the identity; the title is a confirmation that the model is updating the
 * chart it believes it is. Requiring both turns a hallucinated id into a
 * refusal instead of a silent overwrite of an unrelated chart.
 */
export type ChartToolInput =
  | ({ operation?: 'create' } & ChartSpec)
  | ({ operation: 'update'; chartId: string; expectedTitle: string } & ChartSpec)

export interface ChartCreateRequest {
  operation: 'create'
  spec: ChartSpec
}

export interface ChartUpdateRequest {
  operation: 'update'
  chartId: string
  expectedTitle: string
  spec: ChartSpec
}

export type ChartRequest = ChartCreateRequest | ChartUpdateRequest

/** A rejection. `message` is model-facing and states how to fix the call. */
export interface ChartParseFailure {
  ok: false
  message: string
}

export interface ChartParseSuccess {
  ok: true
  request: ChartRequest
}

export type ChartParseResult = ChartParseSuccess | ChartParseFailure

const CARTESIAN_KINDS = new Set<ChartKind>(['line', 'area', 'bar'])
const RADIAL_KINDS = new Set<ChartKind>(['pie', 'doughnut'])

/** True when the kind draws on an X/Y grid (and so supports axes/stacking). */
export function isCartesianChart(kind: ChartKind): boolean {
  return CARTESIAN_KINDS.has(kind)
}

/** True when the kind is a single-series proportion chart. */
export function isRadialChart(kind: ChartKind): boolean {
  return RADIAL_KINDS.has(kind)
}

/**
 * Apply the cumulative transform Ion owns.
 *
 * Pure and shared so the rendered line, the exact-value table, and the tests
 * cannot disagree about what a running total is. A `null` stays `null` — the
 * gap is honest about a missing source reading — and the carried total is held
 * so the next real value continues the series instead of restarting it.
 */
export function cumulativeSeries(data: Array<number | null>): Array<number | null> {
  let total = 0
  return data.map((point) => {
    if (point === null) return null
    total += point
    return total
  })
}

/** The values a dataset actually renders, after any Ion-owned transform. */
export function resolvedSeries(dataset: ChartDataset): Array<number | null> {
  return dataset.cumulative ? cumulativeSeries(dataset.data) : dataset.data
}

/**
 * Format one value for display, honoring the axis format.
 *
 * `Intl` is used rather than hand-rolled string math so currency placement and
 * digit grouping follow the platform locale, which is what makes a copied
 * chart readable to whoever receives it.
 */
export function formatChartValue(value: number, format: ChartValueFormat | undefined): string {
  if (!format) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
  }
  if (format.kind === 'currency') {
    const decimals = format.decimals ?? 2
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: format.currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value)
  }
  const decimals = format.decimals ?? 0
  const rendered = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value)
  return format.kind === 'percent' ? `${rendered}%` : rendered
}

/** The format governing a dataset's values, resolved through its axis. */
export function datasetFormat(spec: ChartSpec, dataset: ChartDataset): ChartValueFormat | undefined {
  return dataset.axis === 'right' ? spec.rightAxis?.format : spec.leftAxis?.format
}
