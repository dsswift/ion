/**
 * chart-config — the one place an Ion `ChartSpec` becomes Chart.js input.
 *
 * ── Why this is a separate pure module ──────────────────────────────────────
 * The card renders a canvas; this decides what the canvas shows. Keeping the
 * translation pure means every mapping decision — which scale a series binds
 * to, how a value is formatted, whether a gap breaks the line — is assertable
 * without a DOM or a real Chart.js instance. The card is then thin enough that
 * its own tests can be about behaviour (copy, paging, the value table) rather
 * than about option plumbing.
 *
 * ── The spec is the contract, Chart.js is an implementation detail ──────────
 * Nothing here leaks back into the persisted record. A Chart.js upgrade that
 * renames an option changes this file only; every chart already written stays
 * renderable because it was never stored in Chart.js's vocabulary.
 */
import type { ColorPalette } from '../../theme-tokens'
import {
  datasetFormat,
  formatChartValue,
  isRadialChart,
  resolvedSeries,
  type ChartAxisId,
  type ChartSpec,
  type ChartValueFormat,
} from '../../../shared/chart-schema'

/**
 * Default series colors, in assignment order.
 *
 * Drawn from the active theme rather than hardcoded so a chart matches the
 * surrounding transcript in every theme (and so the hardcoded-colors scan
 * stays satisfied). The order is chosen for adjacent-hue separation: three
 * series get three clearly different colors without the model specifying any.
 */
export function defaultSeriesColors(colors: ColorPalette): string[] {
  return [
    colors.accent,
    colors.statusRunning,
    colors.statusComplete,
    colors.statusQuestion,
    colors.statusBash,
    colors.statusWarning,
    colors.statusCompacting,
    colors.statusAsync,
  ]
}

/** The color a series renders in: explicit if given, else theme-assigned. */
export function seriesColor(spec: ChartSpec, index: number, palette: string[]): string {
  const explicit = spec.datasets[index]?.color
  if (explicit) return explicit
  return palette[index % palette.length]
}

/** Slice colors for a radial chart, one per label. */
export function sliceColors(spec: ChartSpec, palette: string[]): string[] {
  if (spec.sliceColors) return spec.sliceColors
  return spec.labels.map((_, index) => palette[index % palette.length])
}

/** Chart.js dash pattern for an Ion line style. */
function dashPattern(style: string | undefined): number[] {
  if (style === 'dashed') return [6, 4]
  if (style === 'dotted') return [2, 3]
  return []
}

/**
 * Translucent fill for a shaded band, derived from its line color.
 *
 * The color is the caller's, never this module's: only the alpha is chosen
 * here, so a band tracks whatever theme or model-supplied hex it was given.
 */
function bandFill(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, 0.12)` // hardcoded-ok: alpha applied to a caller-supplied color, no literal channel values
}

export interface ChartConfigInput {
  spec: ChartSpec
  colors: ColorPalette
  /**
   * Opaque background painted behind the plot. Set for PNG export so a copied
   * chart is readable when pasted onto a white document; omitted on screen so
   * the card blends with the transcript.
   */
  exportBackground?: string
}

export interface BuiltChartConfig {
  /** The Chart.js chart type this spec resolves to. */
  type: 'line' | 'bar' | 'pie' | 'doughnut'
  data: Record<string, unknown>
  options: Record<string, unknown>
}

/**
 * Which Chart.js base type renders a spec.
 *
 * `area` is not a Chart.js type — it is a line with fill — so it collapses to
 * `line` here and the fill is applied per dataset.
 */
export function chartJsType(spec: ChartSpec): BuiltChartConfig['type'] {
  switch (spec.kind) {
    case 'pie': return 'pie'
    case 'doughnut': return 'doughnut'
    case 'bar': return 'bar'
    default: return 'line'
  }
}

/** Build the Chart.js `data` block. */
function buildData(spec: ChartSpec, palette: string[]): Record<string, unknown> {
  if (isRadialChart(spec.kind)) {
    const dataset = spec.datasets[0]
    return {
      labels: spec.labels,
      datasets: [{
        label: dataset.label,
        data: resolvedSeries(dataset),
        backgroundColor: sliceColors(spec, palette),
        borderWidth: 0,
      }],
    }
  }

  return {
    labels: spec.labels,
    datasets: spec.datasets.map((dataset, index) => {
      const color = seriesColor(spec, index, palette)
      const renderAsBar = (dataset.kind ?? (spec.kind === 'bar' ? 'bar' : 'line')) === 'bar'
      const filled = dataset.fill ?? spec.kind === 'area'
      return {
        label: dataset.label,
        data: resolvedSeries(dataset),
        type: renderAsBar ? 'bar' : 'line',
        borderColor: color,
        backgroundColor: renderAsBar || filled ? (filled && !renderAsBar ? bandFill(color) : color) : color,
        yAxisID: dataset.axis === 'right' ? 'y1' : 'y',
        fill: !renderAsBar && filled,
        borderDash: renderAsBar ? [] : dashPattern(dataset.style),
        borderWidth: renderAsBar ? 0 : 2,
        pointRadius: renderAsBar ? undefined : 2,
        pointHoverRadius: renderAsBar ? undefined : 4,
        tension: 0,
        // A null is an explicit gap: Chart.js must break the line rather than
        // interpolate across a reading the source never had.
        spanGaps: false,
      }
    }),
  }
}

/**
 * Whether one value scale carries a stack.
 *
 * Stacking is a WITHIN-AXIS transform: series are summed onto a shared
 * baseline, and two series measured against different scales have no shared
 * baseline to sum onto. So an axis stacks only when the chart asks for it AND
 * that axis carries more than one series.
 *
 * Reading `spec.stacked` straight onto every scale is what this replaces. On a
 * stacked bar chart with a single rate line on the right axis, `y1` came back
 * `stacked: true` — a stack of one, which is meaningless to Chart.js but
 * states something untrue about the scale, and invites a reader to assume the
 * right-hand series participates in the stack it can see on the left.
 */
function axisStacks(spec: ChartSpec, axisId: ChartAxisId): boolean {
  if (spec.stacked !== true) return false
  const bound = spec.datasets.filter((dataset) => (dataset.axis ?? 'left') === axisId)
  return bound.length > 1
}

/**
 * Whether one value scale must include zero.
 *
 * Decided PER AXIS from the series bound to it: a bar's height and a filled
 * area's extent are read against a zero baseline, so their scale has to contain
 * it. A plain line states a level rather than a magnitude, so its scale ranges
 * to its own data.
 *
 * This has to be set explicitly because Chart.js decides it CHART-wide. The bar
 * controller carries `overrides.scales._value_ = { beginAtZero: true }`, and
 * `_value_` means every value scale on the chart, not the one the bars use. So
 * on the ordinary dual-scale shape — stacked bars on the left, a rate line on
 * the right — `y1` inherited `beginAtZero` and was dragged down to 0. An
 * 11.2%–14.2% series was then drawn inside a 0%–16% scale: squeezed into the
 * top fifth, a real 0.8-point dip flattened to almost nothing, and the chart
 * understated the movement in its own data. iOS resolves this per axis
 * (`ChartMath.axisAnchorsZero`), so the two clients drew the same spec
 * differently until this was stated here too.
 */
function axisAnchorsZero(spec: ChartSpec, axisId: ChartAxisId): boolean {
  const bound = spec.datasets.filter((dataset) => (dataset.axis ?? 'left') === axisId)
  const stacks = axisStacks(spec, axisId)
  return bound.some((dataset) => {
    const renderAsBar = (dataset.kind ?? (spec.kind === 'bar' ? 'bar' : 'line')) === 'bar'
    if (renderAsBar) return true
    if (dataset.fill ?? spec.kind === 'area') return true
    return stacks
  })
}

/** Build one Chart.js value scale from an Ion axis. */
function buildValueScale(
  spec: ChartSpec,
  axisId: ChartAxisId,
  colors: ColorPalette,
): Record<string, unknown> | null {
  const axis = axisId === 'right' ? spec.rightAxis : spec.leftAxis
  if (axisId === 'right' && !spec.datasets.some((dataset) => dataset.axis === 'right')) return null

  const format = axis?.format
  const logarithmic = axis?.scale === 'logarithmic'
  return {
    type: logarithmic ? 'logarithmic' : 'linear',
    position: axisId === 'right' ? 'right' : 'left',
    stacked: axisStacks(spec, axisId),
    // Stated explicitly on EVERY linear scale, in both directions, because the
    // bar controller's chart-wide `_value_` override would otherwise decide it
    // for a scale that carries no bars. A logarithmic scale is left alone: it
    // cannot contain zero.
    ...(logarithmic ? {} : { beginAtZero: axisAnchorsZero(spec, axisId) }),
    ...(axis?.min !== undefined ? { min: axis.min } : {}),
    ...(axis?.max !== undefined ? { max: axis.max } : {}),
    grid: {
      // Only the left axis draws grid lines; a second set from the right axis
      // would double every horizontal rule.
      display: axisId === 'left',
      color: colors.borderSubtle,
      drawOnChartArea: axisId === 'left',
    },
    border: { display: false },
    ticks: {
      color: colors.textTertiary,
      font: { size: 10 },
      callback: (value: unknown) =>
        (typeof value === 'number' ? formatChartValue(value, format) : String(value)),
    },
    ...(axis?.title ? {
      title: { display: true, text: axis.title, color: colors.textSecondary, font: { size: 10 } },
    } : {}),
  }
}

/** Reference lines and range bands as annotation-plugin entries. */
export function buildAnnotations(spec: ChartSpec, colors: ColorPalette): Record<string, unknown> {
  const annotations: Record<string, unknown> = {}

  spec.rangeBands?.forEach((band, index) => {
    const color = band.color ?? colors.statusComplete
    annotations[`band-${index}`] = {
      type: 'box',
      yScaleID: band.axis === 'right' ? 'y1' : 'y',
      yMin: band.from,
      yMax: band.to,
      backgroundColor: bandFill(color),
      borderWidth: 0,
      // Bands sit behind the data; a band painted over a line would hide the
      // values it is meant to contextualise.
      drawTime: 'beforeDatasetsDraw',
      ...(band.label ? {
        label: {
          display: true,
          content: band.label,
          position: { x: 'start', y: 'start' },
          color: colors.textTertiary,
          font: { size: 10 },
          backgroundColor: 'transparent',
        },
      } : {}),
    }
  })

  spec.referenceLines?.forEach((line, index) => {
    const color = line.color ?? colors.textTertiary
    const axisId: ChartAxisId = line.axis === 'right' ? 'right' : 'left'
    const format = axisId === 'right' ? spec.rightAxis?.format : spec.leftAxis?.format
    annotations[`line-${index}`] = {
      type: 'line',
      yScaleID: axisId === 'right' ? 'y1' : 'y',
      yMin: line.value,
      yMax: line.value,
      borderColor: color,
      borderWidth: 1.5,
      borderDash: dashPattern(line.style ?? 'dashed'),
      drawTime: 'afterDatasetsDraw',
      ...(line.label ? {
        label: {
          display: true,
          // The label carries the value in the axis's own format, so a target
          // line reads as money on a money axis without the user cross-
          // referencing the scale.
          content: `${line.label} · ${formatChartValue(line.value, format)}`,
          position: 'end',
          color: colors.textSecondary,
          backgroundColor: colors.surfaceSecondary,
          font: { size: 10 },
          padding: 4,
        },
      } : {}),
    }
  })

  return annotations
}

/** Tooltip/data-label formatter bound to the dataset's own axis format. */
function formatterForDatasetIndex(spec: ChartSpec): (index: number, value: number) => string {
  return (index, value) => {
    const dataset = spec.datasets[index]
    const format: ChartValueFormat | undefined = dataset
      ? datasetFormat(spec, dataset)
      : spec.leftAxis?.format
    return formatChartValue(value, format)
  }
}

/**
 * Build the complete Chart.js configuration for a spec.
 *
 * Pure: same spec plus same palette yields the same object, which is what lets
 * the tests assert the mapping exactly rather than approximately.
 */
export function buildChartConfig({ spec, colors, exportBackground }: ChartConfigInput): BuiltChartConfig {
  const palette = defaultSeriesColors(colors)
  const radial = isRadialChart(spec.kind)
  const formatValue = formatterForDatasetIndex(spec)
  // A legend earns its space only when there is something to distinguish:
  // several series, or a radial chart whose slices are named nowhere else.
  const legendVisible = spec.legend?.visible ?? (spec.datasets.length > 1 || radial)

  const scales: Record<string, unknown> = {}
  if (!radial) {
    scales.x = {
      // The CATEGORY axis is chart-wide on purpose: it decides whether bars in
      // one period share a slot or sit side by side, which is a grouping
      // question about the whole chart rather than about one value scale.
      stacked: spec.stacked === true,
      grid: { display: false },
      border: { display: false },
      ticks: { color: colors.textTertiary, font: { size: 10 }, autoSkip: true, maxRotation: 0 },
      ...(spec.categoryAxis?.title ? {
        title: { display: true, text: spec.categoryAxis.title, color: colors.textSecondary, font: { size: 10 } },
      } : {}),
    }
    scales.y = buildValueScale(spec, 'left', colors)
    const right = buildValueScale(spec, 'right', colors)
    if (right) scales.y1 = right
  }

  const annotations = radial ? {} : buildAnnotations(spec, colors)

  const options: Record<string, unknown> = {
    responsive: true,
    maintainAspectRatio: false,
    // The transcript re-renders on every streamed chunk; animating each time
    // would repaint a chart the user is trying to read.
    animation: false,
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 4, right: 8, bottom: 0, left: 0 } },
    ...(radial ? {} : { scales }),
    plugins: {
      legend: {
        display: legendVisible,
        position: spec.legend?.position ?? 'bottom',
        labels: {
          color: colors.textSecondary,
          font: { size: 10 },
          boxWidth: 10,
          boxHeight: 10,
          usePointStyle: true,
        },
      },
      tooltip: {
        backgroundColor: colors.surfaceSecondary,
        titleColor: colors.textPrimary,
        bodyColor: colors.textSecondary,
        borderColor: colors.borderSubtle,
        borderWidth: 1,
        padding: 8,
        callbacks: {
          label: (item: { datasetIndex: number; dataset?: { label?: string }; parsed: unknown }) => {
            const parsed = item.parsed as number | { y?: number } | null
            const value = typeof parsed === 'number' ? parsed : parsed?.y
            if (typeof value !== 'number') return item.dataset?.label ?? ''
            const label = item.dataset?.label ? `${item.dataset.label}: ` : ''
            return `${label}${formatValue(item.datasetIndex, value)}`
          },
        },
      },
      datalabels: spec.showValues
        ? {
          display: true,
          color: colors.textSecondary,
          font: { size: 9 },
          anchor: 'end',
          align: 'top',
          formatter: (value: unknown, context: { datasetIndex: number }) =>
            (typeof value === 'number' ? formatValue(context.datasetIndex, value) : ''),
        }
        : { display: false },
      ...(Object.keys(annotations).length > 0 ? { annotation: { annotations } } : {}),
      ...(exportBackground ? { ionExportBackground: { color: exportBackground } } : {}),
    },
  }

  return { type: chartJsType(spec), data: buildData(spec, palette), options }
}

/** One row of the exact-value table shown under a chart. */
export interface ChartValueRow {
  label: string
  values: Array<{ series: string; raw: number | null; display: string }>
}

/**
 * The exact values behind a chart, formatted for the value table.
 *
 * This exists because a chart is an approximation by nature: a bar's height
 * answers "roughly how much" but not "exactly how much". The table is the
 * precise answer, and it renders from the SAME resolved series the canvas
 * draws, so the two can never disagree.
 */
export function chartValueRows(spec: ChartSpec): ChartValueRow[] {
  const resolved = spec.datasets.map((dataset) => resolvedSeries(dataset))
  return spec.labels.map((label, pointIndex) => ({
    label,
    values: spec.datasets.map((dataset, datasetIndex) => {
      const raw = resolved[datasetIndex][pointIndex] ?? null
      const format = isRadialChart(spec.kind) ? spec.leftAxis?.format : datasetFormat(spec, dataset)
      return {
        series: dataset.label,
        raw,
        // A gap prints as an em dash, never as 0: the table must not invent a
        // reading the source did not have.
        display: raw === null ? '—' : formatChartValue(raw, format),
      }
    }),
  }))
}
