/**
 * The strict parser for the Chart Output contract.
 *
 * Split from `chart-schema.ts` so the durable SHAPE (types, limits, and the
 * pure value helpers every renderer needs) stays readable on its own, while the
 * validation machinery — one guarded parser per field — lives here. The
 * cross-field semantic pass that needs the assembled spec lives next door in
 * `chart-semantics.ts` and runs as this parser's final step.
 *
 * `parseChartToolInput` is the single gate in front of every chart: the
 * main-process tool calls it before touching disk, and the renderer calls it
 * before drawing a persisted row. Both therefore agree on exactly which specs
 * are renderable, so a spec that survived an older Ion cannot render as a
 * half-broken chart in a newer one.
 *
 * Every rejection message is MODEL-FACING and states how to fix the call. That
 * is deliberate: the tool result is the only feedback channel the model has, so
 * "labels must contain at most 120 categories (got 400)" is worth far more than
 * "invalid input".
 */

import {
  CHART_LIMITS,
  CHART_SCHEMA_VERSION,
  isCartesianChart,
  isRadialChart,
  type ChartDataset,
  type ChartKind,
  type ChartLegend,
  type ChartParseFailure,
  type ChartParseResult,
  type ChartRangeBand,
  type ChartReferenceLine,
  type ChartSpec,
  type ChartValueAxis,
  type ChartValueFormat,
} from './chart-schema'
import { validateAxisSemantics } from './chart-semantics'

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const CURRENCY_CODE = /^[A-Z]{3}$/

function fail(message: string): ChartParseFailure {
  return { ok: false, message }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reject unknown keys. This is what makes the schema strict: a typo'd or
 * invented field fails loudly instead of being dropped on the floor.
 */
function rejectUnknownKeys(
  where: string,
  value: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length === 0) return null
  return `${where} has unsupported field(s): ${unknown.sort().join(', ')}. Supported: ${[...allowed].sort().join(', ')}.`
}

function parseBoundedString(
  where: string,
  value: unknown,
  max: number,
  { required }: { required: boolean },
): { value?: string; error?: string } {
  if (value === undefined) {
    return required ? { error: `${where} is required.` } : {}
  }
  if (typeof value !== 'string') return { error: `${where} must be a string.` }
  const trimmed = value.trim()
  if (required && trimmed.length === 0) return { error: `${where} must not be empty.` }
  if (trimmed.length > max) return { error: `${where} must be at most ${max} characters (got ${trimmed.length}).` }
  return { value: trimmed }
}

function parseColor(where: string, value: unknown): { value?: string; error?: string } {
  if (value === undefined) return {}
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    return { error: `${where} must be a "#RRGGBB" hex color.` }
  }
  return { value: value.toLowerCase() }
}

function parseFiniteNumber(where: string, value: unknown): { value?: number; error?: string } {
  if (value === undefined) return {}
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { error: `${where} must be a finite number.` }
  }
  return { value }
}

function parseEnum<T extends string>(
  where: string,
  value: unknown,
  allowed: readonly T[],
): { value?: T; error?: string } {
  if (value === undefined) return {}
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return { error: `${where} must be one of: ${allowed.join(', ')}.` }
  }
  return { value: value as T }
}

const FORMAT_KEYS = ['kind', 'decimals', 'currency'] as const

function parseValueFormat(where: string, raw: unknown): { value?: ChartValueFormat; error?: string } {
  if (raw === undefined) return {}
  if (!isPlainObject(raw)) return { error: `${where} must be an object.` }
  const unknown = rejectUnknownKeys(where, raw, FORMAT_KEYS)
  if (unknown) return { error: unknown }

  const kind = parseEnum(`${where}.kind`, raw.kind, ['decimal', 'currency', 'percent'] as const)
  if (kind.error) return { error: kind.error }
  if (!kind.value) return { error: `${where}.kind is required.` }

  const format: ChartValueFormat = { kind: kind.value }

  if (raw.decimals !== undefined) {
    if (
      typeof raw.decimals !== 'number'
      || !Number.isInteger(raw.decimals)
      || raw.decimals < 0
      || raw.decimals > CHART_LIMITS.maxDecimals
    ) {
      return { error: `${where}.decimals must be an integer from 0 to ${CHART_LIMITS.maxDecimals}.` }
    }
    format.decimals = raw.decimals
  }

  if (kind.value === 'currency') {
    if (typeof raw.currency !== 'string' || !CURRENCY_CODE.test(raw.currency)) {
      return { error: `${where}.currency must be a three-letter ISO 4217 code (for example "USD") when kind is "currency".` }
    }
    format.currency = raw.currency
  } else if (raw.currency !== undefined) {
    return { error: `${where}.currency is only valid when kind is "currency".` }
  }

  return { value: format }
}

const VALUE_AXIS_KEYS = ['title', 'scale', 'min', 'max', 'format'] as const

function parseValueAxis(where: string, raw: unknown): { value?: ChartValueAxis; error?: string } {
  if (raw === undefined) return {}
  if (!isPlainObject(raw)) return { error: `${where} must be an object.` }
  const unknown = rejectUnknownKeys(where, raw, VALUE_AXIS_KEYS)
  if (unknown) return { error: unknown }

  const axis: ChartValueAxis = {}

  const title = parseBoundedString(`${where}.title`, raw.title, CHART_LIMITS.maxAxisTitleChars, { required: false })
  if (title.error) return { error: title.error }
  if (title.value) axis.title = title.value

  const scale = parseEnum(`${where}.scale`, raw.scale, ['linear', 'logarithmic'] as const)
  if (scale.error) return { error: scale.error }
  if (scale.value) axis.scale = scale.value

  const min = parseFiniteNumber(`${where}.min`, raw.min)
  if (min.error) return { error: min.error }
  if (min.value !== undefined) axis.min = min.value

  const max = parseFiniteNumber(`${where}.max`, raw.max)
  if (max.error) return { error: max.error }
  if (max.value !== undefined) axis.max = max.value

  if (axis.min !== undefined && axis.max !== undefined && axis.min >= axis.max) {
    return { error: `${where}.min must be less than ${where}.max.` }
  }
  if (axis.scale === 'logarithmic' && axis.min !== undefined && axis.min <= 0) {
    return { error: `${where}.min must be greater than 0 on a logarithmic axis.` }
  }

  const format = parseValueFormat(`${where}.format`, raw.format)
  if (format.error) return { error: format.error }
  if (format.value) axis.format = format.value

  return { value: axis }
}

const DATASET_KEYS = [
  'label', 'data', 'color', 'kind', 'axis', 'fill', 'style', 'cumulative',
] as const

function parseDataset(
  index: number,
  raw: unknown,
  pointCount: number,
  chartKind: ChartKind,
): { value?: ChartDataset; error?: string } {
  const where = `datasets[${index}]`
  if (!isPlainObject(raw)) return { error: `${where} must be an object.` }
  const unknown = rejectUnknownKeys(where, raw, DATASET_KEYS)
  if (unknown) return { error: unknown }

  const label = parseBoundedString(`${where}.label`, raw.label, CHART_LIMITS.maxSeriesLabelChars, { required: true })
  if (label.error) return { error: label.error }

  if (!Array.isArray(raw.data)) return { error: `${where}.data must be an array.` }
  if (raw.data.length !== pointCount) {
    return { error: `${where}.data has ${raw.data.length} value(s) but labels has ${pointCount}. Every dataset must align with labels; use null for a gap.` }
  }
  const data: Array<number | null> = []
  for (let i = 0; i < raw.data.length; i += 1) {
    const point = raw.data[i]
    if (point === null) {
      data.push(null)
      continue
    }
    if (typeof point !== 'number' || !Number.isFinite(point)) {
      return { error: `${where}.data[${i}] must be a finite number or null.` }
    }
    data.push(point)
  }

  const dataset: ChartDataset = { label: label.value!, data }

  const color = parseColor(`${where}.color`, raw.color)
  if (color.error) return { error: color.error }
  if (color.value) dataset.color = color.value

  const kind = parseEnum(`${where}.kind`, raw.kind, ['line', 'bar'] as const)
  if (kind.error) return { error: kind.error }
  if (kind.value) {
    if (!isCartesianChart(chartKind)) {
      return { error: `${where}.kind is only valid on line, area, or bar charts.` }
    }
    dataset.kind = kind.value
  }

  const axis = parseEnum(`${where}.axis`, raw.axis, ['left', 'right'] as const)
  if (axis.error) return { error: axis.error }
  if (axis.value) {
    if (!isCartesianChart(chartKind)) {
      return { error: `${where}.axis is only valid on line, area, or bar charts.` }
    }
    dataset.axis = axis.value
  }

  for (const flag of ['fill', 'cumulative'] as const) {
    const value = raw[flag]
    if (value === undefined) continue
    if (typeof value !== 'boolean') return { error: `${where}.${flag} must be a boolean.` }
    dataset[flag] = value
  }

  const style = parseEnum(`${where}.style`, raw.style, ['solid', 'dashed', 'dotted'] as const)
  if (style.error) return { error: style.error }
  if (style.value) dataset.style = style.value

  return { value: dataset }
}

const REFERENCE_LINE_KEYS = ['value', 'label', 'color', 'axis', 'style'] as const

function parseReferenceLine(index: number, raw: unknown): { value?: ChartReferenceLine; error?: string } {
  const where = `referenceLines[${index}]`
  if (!isPlainObject(raw)) return { error: `${where} must be an object.` }
  const unknown = rejectUnknownKeys(where, raw, REFERENCE_LINE_KEYS)
  if (unknown) return { error: unknown }

  const value = parseFiniteNumber(`${where}.value`, raw.value)
  if (value.error) return { error: value.error }
  if (value.value === undefined) return { error: `${where}.value is required.` }

  const line: ChartReferenceLine = { value: value.value }

  const label = parseBoundedString(`${where}.label`, raw.label, CHART_LIMITS.maxAnnotationLabelChars, { required: false })
  if (label.error) return { error: label.error }
  if (label.value) line.label = label.value

  const color = parseColor(`${where}.color`, raw.color)
  if (color.error) return { error: color.error }
  if (color.value) line.color = color.value

  const axis = parseEnum(`${where}.axis`, raw.axis, ['left', 'right'] as const)
  if (axis.error) return { error: axis.error }
  if (axis.value) line.axis = axis.value

  const style = parseEnum(`${where}.style`, raw.style, ['solid', 'dashed', 'dotted'] as const)
  if (style.error) return { error: style.error }
  if (style.value) line.style = style.value

  return { value: line }
}

const RANGE_BAND_KEYS = ['from', 'to', 'label', 'color', 'axis'] as const

function parseRangeBand(index: number, raw: unknown): { value?: ChartRangeBand; error?: string } {
  const where = `rangeBands[${index}]`
  if (!isPlainObject(raw)) return { error: `${where} must be an object.` }
  const unknown = rejectUnknownKeys(where, raw, RANGE_BAND_KEYS)
  if (unknown) return { error: unknown }

  const from = parseFiniteNumber(`${where}.from`, raw.from)
  if (from.error) return { error: from.error }
  if (from.value === undefined) return { error: `${where}.from is required.` }

  const to = parseFiniteNumber(`${where}.to`, raw.to)
  if (to.error) return { error: to.error }
  if (to.value === undefined) return { error: `${where}.to is required.` }

  if (from.value >= to.value) return { error: `${where}.from must be less than ${where}.to.` }

  const band: ChartRangeBand = { from: from.value, to: to.value }

  const label = parseBoundedString(`${where}.label`, raw.label, CHART_LIMITS.maxAnnotationLabelChars, { required: false })
  if (label.error) return { error: label.error }
  if (label.value) band.label = label.value

  const color = parseColor(`${where}.color`, raw.color)
  if (color.error) return { error: color.error }
  if (color.value) band.color = color.value

  const axis = parseEnum(`${where}.axis`, raw.axis, ['left', 'right'] as const)
  if (axis.error) return { error: axis.error }
  if (axis.value) band.axis = axis.value

  return { value: band }
}

const LEGEND_KEYS = ['visible', 'position'] as const

function parseLegend(raw: unknown): { value?: ChartLegend; error?: string } {
  if (raw === undefined) return {}
  if (!isPlainObject(raw)) return { error: 'legend must be an object.' }
  const unknown = rejectUnknownKeys('legend', raw, LEGEND_KEYS)
  if (unknown) return { error: unknown }

  const legend: ChartLegend = {}
  if (raw.visible !== undefined) {
    if (typeof raw.visible !== 'boolean') return { error: 'legend.visible must be a boolean.' }
    legend.visible = raw.visible
  }
  const position = parseEnum('legend.position', raw.position, ['top', 'bottom', 'left', 'right'] as const)
  if (position.error) return { error: position.error }
  if (position.value) legend.position = position.value
  return { value: legend }
}

const SPEC_KEYS = [
  'schemaVersion', 'kind', 'title', 'subtitle', 'caption', 'source', 'labels',
  'datasets', 'categoryAxis', 'leftAxis', 'rightAxis', 'sliceColors', 'legend',
  'stacked', 'showValues', 'referenceLines', 'rangeBands',
] as const

const ENVELOPE_KEYS = ['operation', 'chartId', 'expectedTitle'] as const

/**
 * Parse and validate raw tool input into a `ChartRequest`.
 *
 * One function is the single gate: the main-process tool calls it before
 * touching disk, and the renderer calls it before drawing a persisted row.
 * Both therefore agree on exactly which specs are renderable, so a spec that
 * survived an older Ion cannot render as a half-broken chart in a newer one.
 */
export function parseChartToolInput(raw: unknown): ChartParseResult {
  if (!isPlainObject(raw)) return fail('RenderChart input must be a JSON object.')

  const unknownTop = rejectUnknownKeys('input', raw, [...SPEC_KEYS, ...ENVELOPE_KEYS])
  if (unknownTop) return fail(unknownTop)

  if (raw.schemaVersion !== CHART_SCHEMA_VERSION) {
    return fail(`schemaVersion must be ${CHART_SCHEMA_VERSION}.`)
  }

  const operation = parseEnum('operation', raw.operation, ['create', 'update'] as const)
  if (operation.error) return fail(operation.error)
  const op = operation.value ?? 'create'

  let chartId: string | undefined
  let expectedTitle: string | undefined
  if (op === 'update') {
    const id = parseBoundedString('chartId', raw.chartId, 200, { required: true })
    if (id.error) return fail(id.error)
    chartId = id.value
    const expected = parseBoundedString('expectedTitle', raw.expectedTitle, CHART_LIMITS.maxTitleChars, { required: true })
    if (expected.error) return fail(expected.error)
    expectedTitle = expected.value
  } else {
    if (raw.chartId !== undefined) return fail('chartId is only valid when operation is "update".')
    if (raw.expectedTitle !== undefined) return fail('expectedTitle is only valid when operation is "update".')
  }

  const kind = parseEnum('kind', raw.kind, ['line', 'area', 'bar', 'pie', 'doughnut'] as const)
  if (kind.error) return fail(kind.error)
  if (!kind.value) return fail('kind is required.')

  const title = parseBoundedString('title', raw.title, CHART_LIMITS.maxTitleChars, { required: true })
  if (title.error) return fail(title.error)

  const spec: ChartSpec = {
    schemaVersion: CHART_SCHEMA_VERSION,
    kind: kind.value,
    title: title.value!,
    labels: [],
    datasets: [],
  }

  for (const [field, max] of [
    ['subtitle', CHART_LIMITS.maxSubtitleChars],
    ['caption', CHART_LIMITS.maxCaptionChars],
    ['source', CHART_LIMITS.maxSourceChars],
  ] as const) {
    const parsed = parseBoundedString(field, raw[field], max, { required: false })
    if (parsed.error) return fail(parsed.error)
    if (parsed.value) spec[field] = parsed.value
  }

  if (!Array.isArray(raw.labels)) return fail('labels must be an array of strings.')
  if (raw.labels.length === 0) return fail('labels must contain at least one category.')
  if (raw.labels.length > CHART_LIMITS.maxPoints) {
    return fail(`labels must contain at most ${CHART_LIMITS.maxPoints} categories (got ${raw.labels.length}).`)
  }
  for (let i = 0; i < raw.labels.length; i += 1) {
    const label = parseBoundedString(`labels[${i}]`, raw.labels[i], CHART_LIMITS.maxLabelChars, { required: true })
    if (label.error) return fail(label.error)
    spec.labels.push(label.value!)
  }

  if (!Array.isArray(raw.datasets)) return fail('datasets must be an array.')
  if (raw.datasets.length === 0) return fail('datasets must contain at least one series.')
  if (raw.datasets.length > CHART_LIMITS.maxDatasets) {
    return fail(`datasets must contain at most ${CHART_LIMITS.maxDatasets} series (got ${raw.datasets.length}).`)
  }
  if (isRadialChart(spec.kind) && raw.datasets.length !== 1) {
    return fail(`a ${spec.kind} chart takes exactly one dataset (got ${raw.datasets.length}). Use a bar chart to compare several series.`)
  }
  const seenLabels = new Set<string>()
  for (let i = 0; i < raw.datasets.length; i += 1) {
    const dataset = parseDataset(i, raw.datasets[i], spec.labels.length, spec.kind)
    if (dataset.error) return fail(dataset.error)
    const key = dataset.value!.label.toLowerCase()
    if (seenLabels.has(key)) {
      return fail(`datasets[${i}].label duplicates an earlier series ("${dataset.value!.label}"). Series labels must be unique so the legend and value table stay readable.`)
    }
    seenLabels.add(key)
    spec.datasets.push(dataset.value!)
  }

  if (raw.categoryAxis !== undefined) {
    if (!isPlainObject(raw.categoryAxis)) return fail('categoryAxis must be an object.')
    const unknown = rejectUnknownKeys('categoryAxis', raw.categoryAxis, ['title'] as const)
    if (unknown) return fail(unknown)
    const axisTitle = parseBoundedString('categoryAxis.title', raw.categoryAxis.title, CHART_LIMITS.maxAxisTitleChars, { required: false })
    if (axisTitle.error) return fail(axisTitle.error)
    if (axisTitle.value) spec.categoryAxis = { title: axisTitle.value }
  }

  for (const field of ['leftAxis', 'rightAxis'] as const) {
    const axis = parseValueAxis(field, raw[field])
    if (axis.error) return fail(axis.error)
    if (axis.value) spec[field] = axis.value
  }

  if ((spec.leftAxis || spec.rightAxis || spec.categoryAxis) && !isCartesianChart(spec.kind)) {
    return fail(`axes are only valid on line, area, or bar charts, not ${spec.kind}.`)
  }

  if (raw.sliceColors !== undefined) {
    if (!isRadialChart(spec.kind)) return fail('sliceColors is only valid on pie or doughnut charts.')
    if (!Array.isArray(raw.sliceColors)) return fail('sliceColors must be an array of "#RRGGBB" strings.')
    if (raw.sliceColors.length !== spec.labels.length) {
      return fail(`sliceColors has ${raw.sliceColors.length} entries but labels has ${spec.labels.length}. Supply one color per slice or omit sliceColors.`)
    }
    const colors: string[] = []
    for (let i = 0; i < raw.sliceColors.length; i += 1) {
      const color = parseColor(`sliceColors[${i}]`, raw.sliceColors[i])
      if (color.error) return fail(color.error)
      if (!color.value) return fail(`sliceColors[${i}] must be a "#RRGGBB" hex color.`)
      colors.push(color.value)
    }
    spec.sliceColors = colors
  }

  const legend = parseLegend(raw.legend)
  if (legend.error) return fail(legend.error)
  if (legend.value) spec.legend = legend.value

  for (const flag of ['stacked', 'showValues'] as const) {
    const value = raw[flag]
    if (value === undefined) continue
    if (typeof value !== 'boolean') return fail(`${flag} must be a boolean.`)
    if (flag === 'stacked' && value && !isCartesianChart(spec.kind)) {
      return fail('stacked is only valid on line, area, or bar charts.')
    }
    spec[flag] = value
  }

  if (raw.referenceLines !== undefined) {
    if (!Array.isArray(raw.referenceLines)) return fail('referenceLines must be an array.')
    if (!isCartesianChart(spec.kind)) return fail('referenceLines are only valid on line, area, or bar charts.')
    if (raw.referenceLines.length > CHART_LIMITS.maxReferenceLines) {
      return fail(`referenceLines must contain at most ${CHART_LIMITS.maxReferenceLines} entries (got ${raw.referenceLines.length}).`)
    }
    const lines: ChartReferenceLine[] = []
    for (let i = 0; i < raw.referenceLines.length; i += 1) {
      const line = parseReferenceLine(i, raw.referenceLines[i])
      if (line.error) return fail(line.error)
      lines.push(line.value!)
    }
    if (lines.length > 0) spec.referenceLines = lines
  }

  if (raw.rangeBands !== undefined) {
    if (!Array.isArray(raw.rangeBands)) return fail('rangeBands must be an array.')
    if (!isCartesianChart(spec.kind)) return fail('rangeBands are only valid on line, area, or bar charts.')
    if (raw.rangeBands.length > CHART_LIMITS.maxRangeBands) {
      return fail(`rangeBands must contain at most ${CHART_LIMITS.maxRangeBands} entries (got ${raw.rangeBands.length}).`)
    }
    const bands: ChartRangeBand[] = []
    for (let i = 0; i < raw.rangeBands.length; i += 1) {
      const band = parseRangeBand(i, raw.rangeBands[i])
      if (band.error) return fail(band.error)
      bands.push(band.value!)
    }
    if (bands.length > 0) spec.rangeBands = bands
  }

  const semantic = validateAxisSemantics(spec)
  if (semantic) return fail(semantic)

  return op === 'update'
    ? { ok: true, request: { operation: 'update', chartId: chartId!, expectedTitle: expectedTitle!, spec } }
    : { ok: true, request: { operation: 'create', spec } }
}
