/**
 * RenderChart — the Studio client tool that turns supplied numbers into a
 * native Chart Output in the transcript.
 *
 * ── Why a client tool rather than an engine tool ────────────────────────────
 * Rendering is a client concern. The engine has no canvas, no theme, and no
 * opinion about how a chart should look, so a chart tool in engine core would
 * force one product's rendering opinion on every consumer. The client-tool
 * gate (ADR-025) exists for exactly this: the Desktop declares the tool, the
 * engine transports the call, and the Desktop executes it.
 *
 * ── Why the input is the durable record ─────────────────────────────────────
 * The tool's INPUT is the chart. The engine already persists tool-call input
 * and replays it on reload, so a chart survives restart, rewind, and history
 * reload with no extra storage layer and no new event type. The tool's OUTPUT
 * is deliberately a short confirmation: echoing the dataset back would double
 * its cost in the model's context for no added information.
 *
 * ── Ownership is injected, never accepted from the model ────────────────────
 * The conversation, the tool-call id, and the chart id are all resolved from
 * the session the call arrived on. A model cannot name another conversation's
 * chart, and cannot mint its own identity.
 */
import type { ClientToolDef } from '../shared/types-tool-gate'
import {
  CHART_LIMITS,
  CHART_SCHEMA_VERSION,
} from '../shared/chart-schema'
import { parseChartToolInput } from '../shared/chart-parse'
import { formatChartResultSummary } from '../shared/chart-result'
import {
  CHART_RESOURCE_KIND,
  chartResourceItem,
  commitChartRequest,
  type ChartRecord,
} from './chart-resource-store'
import { log as _log, warn as _warn } from './logger'

const TAG = 'chart-tool'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export const RENDER_CHART_TOOL_NAME = 'RenderChart'

/** Execution context the responder injects. Never model-supplied. */
export interface ChartToolContext {
  /** Engine session key the call arrived on. */
  sessionKey: string
  /** Durable conversation id that owns the chart. */
  conversationId: string
  /** Correlator for this invocation; becomes the chart id on create. */
  toolCallId: string
}

export interface ChartToolResult {
  content: string
  isError: boolean
  /** Present on success so the caller can publish the resource delta. */
  publish?: { op: 'create' | 'update'; record: ChartRecord }
}

const VALUE_FORMAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: ['decimal', 'currency', 'percent'], description: 'How values on this axis are written.' },
    decimals: { type: 'integer', minimum: 0, maximum: CHART_LIMITS.maxDecimals, description: 'Decimal places. Defaults to 0 for decimal/percent and 2 for currency.' },
    currency: {
      type: 'string',
      pattern: '^[A-Z]{3}$',
      description: 'ISO 4217 code such as "USD". Required when kind is "currency". Omit the field entirely for decimal or percent — an empty string is not a valid substitute.',
    },
  },
  // Currency is required for a currency format and forbidden otherwise. The
  // `else` branch demands ABSENCE, because `currency: ""` alongside a percent
  // axis was one of the malformed shapes a flat schema invited.
  if: { properties: { kind: { const: 'currency' } }, required: ['kind'] },
  then: { required: ['currency'] },
  else: { not: { required: ['currency'] } },
}

const VALUE_AXIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', maxLength: CHART_LIMITS.maxAxisTitleChars, description: 'Axis label.' },
    scale: { type: 'string', enum: ['linear', 'logarithmic'], description: 'Defaults to linear. A logarithmic axis requires every bound value to be positive and non-null.' },
    min: { type: 'number', description: 'Lower bound.' },
    max: { type: 'number', description: 'Upper bound.' },
    format: VALUE_FORMAT_SCHEMA,
  },
}

const CHART_KIND_SCHEMA = {
  // Radial charts may carry slice colors, but have no Cartesian axes or
  // annotations. Cartesian charts must omit slice colors entirely.
  if: { properties: { kind: { enum: ['pie', 'doughnut'] } }, required: ['kind'] },
  then: {
    not: {
      anyOf: [
        { required: ['leftAxis'] },
        { required: ['rightAxis'] },
        { required: ['categoryAxis'] },
        { required: ['referenceLines'] },
        { required: ['rangeBands'] },
        { required: ['stacked'] },
      ],
    },
  },
  else: { not: { required: ['sliceColors'] } },
}

const INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'kind', 'title', 'labels', 'datasets'],
  properties: {
    schemaVersion: { type: 'integer', enum: [CHART_SCHEMA_VERSION], description: `Always ${CHART_SCHEMA_VERSION}.` },
    operation: {
      type: 'string',
      enum: ['create', 'update'],
      description: 'Omit (or "create") for a new chart. Use "update" to replace an existing chart with a corrected version; the old revision stays in history and the card gains revision controls.',
    },
    chartId: {
      type: 'string',
      minLength: 1,
      description: 'ONLY for operation "update": the id returned when the chart was created. Omit the field entirely on a create — an empty string is not a valid substitute.',
    },
    expectedTitle: {
      type: 'string',
      minLength: 1,
      description: 'ONLY for operation "update": the chart\'s CURRENT title. A mismatch refuses the update rather than overwriting the wrong chart. Omit the field entirely on a create.',
    },
    kind: { type: 'string', enum: ['line', 'area', 'bar', 'pie', 'doughnut'], description: 'Chart type. Pie and doughnut take exactly one dataset.' },
    title: { type: 'string', maxLength: CHART_LIMITS.maxTitleChars, description: 'Chart title. Must be unique within the conversation — it is how the user and you refer to this chart later.' },
    subtitle: { type: 'string', maxLength: CHART_LIMITS.maxSubtitleChars, description: 'Optional supporting line under the title.' },
    caption: { type: 'string', maxLength: CHART_LIMITS.maxCaptionChars, description: 'Optional explanatory note shown under the chart and included when the user copies it.' },
    source: { type: 'string', maxLength: CHART_LIMITS.maxSourceChars, description: 'Optional provenance note (where these numbers came from).' },
    labels: {
      type: 'array',
      minItems: 1,
      maxItems: CHART_LIMITS.maxPoints,
      items: { type: 'string', maxLength: CHART_LIMITS.maxLabelChars },
      description: `Category labels along the X axis (or slice names for pie/doughnut). At most ${CHART_LIMITS.maxPoints}.`,
    },
    datasets: {
      type: 'array',
      minItems: 1,
      maxItems: CHART_LIMITS.maxDatasets,
      description: `One entry per series, at most ${CHART_LIMITS.maxDatasets}. Every series renders on the same chart, so this is how you put several lines or grouped bars side by side.`,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'data'],
        properties: {
          label: { type: 'string', maxLength: CHART_LIMITS.maxSeriesLabelChars, description: 'Series name shown in the legend and value table.' },
          data: {
            type: 'array',
            items: { type: ['number', 'null'] },
            description: 'One value per label, same length and order. Use null for a genuinely missing reading — it renders as a gap, never as zero.',
          },
          color: { type: 'string', description: '"#RRGGBB". Omit to let the active theme assign a distinct color.' },
          kind: { type: 'string', enum: ['line', 'bar'], description: 'Override the chart kind for this series to mix bars and lines on one chart.' },
          axis: { type: 'string', enum: ['left', 'right'], description: 'Which value axis measures this series. Use "right" for a second scale such as a rate beside a volume.' },
          fill: { type: 'boolean', description: 'Fill the area under a line.' },
          style: { type: 'string', enum: ['solid', 'dashed', 'dotted'], description: 'Line style; dashed reads well for a prior-period comparison.' },
          cumulative: { type: 'boolean', description: 'Render the running total of data. Ion computes it, so supply the per-period values, not pre-summed ones.' },
        },
      },
    },
    categoryAxis: {
      type: 'object',
      additionalProperties: false,
      properties: { title: { type: 'string', maxLength: CHART_LIMITS.maxAxisTitleChars } },
      description: 'X-axis label.',
    },
    leftAxis: VALUE_AXIS_SCHEMA,
    rightAxis: VALUE_AXIS_SCHEMA,
    sliceColors: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
      description: 'Pie/doughnut ONLY: one "#RRGGBB" per label. Omit the field entirely on any other kind — an empty array is not a valid substitute.',
    },
    legend: {
      type: 'object',
      additionalProperties: false,
      properties: {
        visible: { type: 'boolean' },
        position: { type: 'string', enum: ['top', 'bottom', 'left', 'right'] },
      },
    },
    stacked: { type: 'boolean', description: 'Stack Cartesian series instead of grouping them.' },
    showValues: { type: 'boolean', description: 'Print each value on the chart itself. Useful when the user will share the image.' },
    referenceLines: {
      type: 'array',
      maxItems: CHART_LIMITS.maxReferenceLines,
      description: 'Horizontal marker lines — a target, a threshold, or an average.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: {
          value: { type: 'number' },
          label: { type: 'string', maxLength: CHART_LIMITS.maxAnnotationLabelChars },
          color: { type: 'string' },
          axis: { type: 'string', enum: ['left', 'right'] },
          style: { type: 'string', enum: ['solid', 'dashed', 'dotted'] },
        },
      },
    },
    rangeBands: {
      type: 'array',
      maxItems: CHART_LIMITS.maxRangeBands,
      description: 'Shaded horizontal bands — an expected range or operating zone.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to'],
        properties: {
          from: { type: 'number' },
          to: { type: 'number' },
          label: { type: 'string', maxLength: CHART_LIMITS.maxAnnotationLabelChars },
          color: { type: 'string' },
          axis: { type: 'string', enum: ['left', 'right'] },
        },
      },
    },
  },
  // ── Conditional rules, enforced by the schema rather than only the parser ──
  //
  // WHY: these fields are valid only in specific combinations, and a flat
  // property list lets a caller send `chartId: ""` on a create or
  // `sliceColors: []` on a bar chart. The strict parser rejects both, so no
  // bad chart is ever stored — but the caller only learns after a failed
  // round trip, and a caller that fills every advertised field will keep
  // producing the same refusal. Encoding the rules here makes the invalid
  // shapes fail schema validation up front, and (for providers that use the
  // schema to constrain generation) stops them being produced at all.
  //
  // The condition must be the root schema's direct `if`/`then`/`else` rather
  // than a root `allOf`: Anthropic accepts conditions within an object schema
  // but rejects oneOf/allOf/anyOf as a tool input schema's top-level keyword.
  // `else: { not: { anyOf: [...] } }` demands ABSENCE, not emptiness.
  //
  // The engine validates client-tool input with google/jsonschema-go, which
  // implements these branches. Pinned by studio-chart-tool-schema.test.ts.
  if: { properties: { operation: { const: 'update' } }, required: ['operation'] },
  then: {
    required: ['chartId', 'expectedTitle'],
    ...CHART_KIND_SCHEMA,
  },
  else: {
    not: { anyOf: [{ required: ['chartId'] }, { required: ['expectedTitle'] }] },
    ...CHART_KIND_SCHEMA,
  },
}

const DESCRIPTION = [
  'Render a chart in the conversation from data you already have.',
  'The chart is drawn natively from the exact numbers you supply — it is not an image and nothing is estimated, so it is safe for figures the user will share.',
  'Use it whenever a numeric answer is easier to see than to read: comparisons across periods or categories, trends, composition, or a running total.',
  'Several series belong on ONE chart (multiple colored lines, grouped bars, or mixed bars and a line on a second axis); call the tool again for a genuinely different chart.',
  'Supply raw per-period values and let the chart do the arithmetic: set cumulative on a series for a running total rather than pre-summing it yourself.',
  'Use null for a missing reading — it renders as an honest gap, never as zero.',
  'Titles must be unique in the conversation. To correct or refresh a chart you already rendered, call again with operation "update", its chartId, and its current title as expectedTitle: the card updates in place, keeps its earlier revisions browsable, and stays a single entry in the attachments panel.',
  'OMIT every field you are not using — never send an empty string or an empty array as a placeholder.',
  'A new chart sends NO operation, NO chartId and NO expectedTitle. An update sends all three.',
  'sliceColors is pie/doughnut only; leftAxis, rightAxis, categoryAxis, referenceLines, rangeBands and stacked are line/area/bar only; a format\'s currency field exists only when its kind is "currency".',
].join(' ')

/** The declaration advertised to the engine at start_session. */
export const RENDER_CHART_TOOL: ClientToolDef = {
  name: RENDER_CHART_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: INPUT_SCHEMA,
  // Plan mode is read-only for the workspace, but a chart writes nothing the
  // operator has to review: it renders data the model already holds. Allowing
  // it in plan mode is what lets an analysis conversation stay visual.
  planModeSafe: true,
}

/**
 * Execute one `RenderChart` call.
 *
 * Validation runs before any disk write, and the disk write completes before
 * the caller publishes anything, so a chart is never announced to a client it
 * cannot be restored for.
 */
export function executeRenderChart(
  input: Record<string, unknown>,
  ctx: ChartToolContext,
): ChartToolResult {
  const parsed = parseChartToolInput(input)
  if (!parsed.ok) {
    warn('chart input rejected', {
      session_key: ctx.sessionKey,
      conversation_id: ctx.conversationId,
      reason: parsed.message,
    })
    return { content: `Chart rejected: ${parsed.message}`, isError: true }
  }

  const request = parsed.request
  log('chart request accepted', {
    session_key: ctx.sessionKey,
    conversation_id: ctx.conversationId,
    operation: request.operation,
    kind: request.spec.kind,
    datasets: request.spec.datasets.length,
    points: request.spec.labels.length,
  })

  const committed = commitChartRequest(request, {
    conversationId: ctx.conversationId,
    toolCallId: ctx.toolCallId,
  })
  if (!committed.ok) {
    return { content: `Chart rejected: ${committed.message}`, isError: true }
  }

  const { record, op } = committed
  // The summary is built by the SHARED formatter so the renderer's parser and
  // this writer cannot disagree about where the chart id sits. The id in this
  // text is the transcript's only source of chart identity.
  const summary = formatChartResultSummary({
    operation: op,
    chartId: record.chartId,
    title: record.title,
    kind: record.spec.kind,
    datasets: record.spec.datasets.length,
    points: record.spec.labels.length,
    revision: record.revision,
  })

  return { content: summary, isError: false, publish: { op, record } }
}

/** Build the resource payload for a committed chart. */
export function chartPublishPayload(record: ChartRecord): {
  kind: string
  item: ReturnType<typeof chartResourceItem>
} {
  return { kind: CHART_RESOURCE_KIND, item: chartResourceItem(record) }
}
