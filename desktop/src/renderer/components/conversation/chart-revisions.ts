/**
 * chart-revisions — derives what the transcript shows for every chart, from
 * the tool rows the active branch can actually see.
 *
 * ── Why derivation rather than stored render state ──────────────────────────
 * A chart's revisions ARE its `RenderChart` tool rows. Deriving from the
 * visible message list means rewind and fork are correct by construction: a
 * revision the branch no longer contains simply is not in the input, so it
 * cannot appear as current, cannot be paged to, and cannot leave a marker.
 * Storing "which revision is current" in the renderer would need a separate
 * invalidation rule for every history mutation, and each one would be a place
 * to get it wrong.
 *
 * ── One full card, markers everywhere else ──────────────────────────────────
 * Only the NEWEST revision of a chart draws a full card. Earlier tool rows
 * keep their place in history — the turn that produced them still reads
 * truthfully — but render as a compact marker pointing at where the chart
 * lives now. That is what stops a conversation with six chart refinements from
 * carrying six large, five of them wrong.
 */
import { parseChartToolInput } from '../../../shared/chart-parse'
import { parseChartResultId } from '../../../shared/chart-result'
import type { ChartSpec } from '../../../shared/chart-schema'
import type { Message } from '../../../shared/types'

/** The tool name whose rows carry chart revisions. */
export const CHART_TOOL_NAME = 'RenderChart'

/** One immutable revision, in branch order. */
export interface ChartRevision {
  /** Tool-row id — the transcript anchor for this revision. */
  messageId: string
  spec: ChartSpec
  /** 1-based position in this chart's revision list. */
  revision: number
}

/**
 * A stable, per-row view of chart render state.
 *
 * Keyed by tool-row id and compared by VALUE, so a row can be told "your chart
 * did not change" without every row having to depend on the whole message
 * array. That distinction is load-bearing: passing the full list into each
 * memoized transcript row defeated the row memo entirely (the store replaces
 * the array on every stream chunk), which re-rendered every virtual row per
 * chunk and left the virtualizer measuring rows mid-churn — the overlapping
 * transcript rows that shipped with the first chart build.
 */
export type ChartRenderIndex = Map<string, ChartRowRender>

/**
 * True when two render entries mean the same thing on screen.
 *
 * Compared field-by-field rather than by reference because the index is
 * rebuilt whenever the message array changes; a fresh object with identical
 * contents must NOT invalidate a row.
 */
export function chartRenderEqual(a?: ChartRowRender, b?: ChartRowRender): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.kind !== b.kind) return false
  if (a.kind === 'moved' && b.kind === 'moved') {
    return a.chartId === b.chartId
      && a.title === b.title
      && a.targetMessageId === b.targetMessageId
  }
  if (a.kind === 'current' && b.kind === 'current') {
    // Identity plus revision depth plus which revision is current is the whole
    // visible contract: the card redraws when any of them moves.
    return a.timeline.chartId === b.timeline.chartId
      && a.timeline.title === b.timeline.title
      && a.timeline.currentMessageId === b.timeline.currentMessageId
      && a.timeline.revisions.length === b.timeline.revisions.length
      && a.timeline.revisions.every((rev, i) => rev.messageId === b.timeline.revisions[i]?.messageId)
  }
  return false
}

/** Every revision of one chart, plus where it currently lives. */
export interface ChartTimeline {
  chartId: string
  /** Title of the newest revision. */
  title: string
  revisions: ChartRevision[]
  /** Anchor of the newest revision: where the attachments panel jumps. */
  currentMessageId: string
}

/** What a single tool row renders as. */
export type ChartRowRender =
  | { kind: 'current'; timeline: ChartTimeline }
  | { kind: 'moved'; chartId: string; title: string; targetMessageId: string }

/**
 * Read the chart id a completed row reports.
 *
 * The id comes from the row's RESULT, which the main process wrote and the
 * engine persisted verbatim. It is never derived from the row id: a tool row
 * is keyed by the engine's tool-use id (`toolu_…`), while a chart id is minted
 * from the tool-gate request id, and those two identifiers never match. An
 * earlier version derived one from the other, so every `update` row failed to
 * find its timeline and was dropped — no revision badge, no previous/next
 * controls. `chart-result.ts` owns the format for both sides.
 */
function chartIdOfRow(message: Message): string | null {
  return parseChartResultId(message.content)
}

/** True when a message is a completed, non-error chart tool row. */
function isRenderedChartRow(message: Message): boolean {
  return message.role === 'tool'
    && message.toolName === CHART_TOOL_NAME
    && message.toolStatus !== 'running'
    && message.toolStatus !== 'error'
    && !!message.toolInput
}

/**
 * Build every chart timeline visible in a message list.
 *
 * Only successful rows contribute: a refused call stays an ordinary tool error
 * in the transcript and must not alter the current chart, because the chart it
 * failed to produce never existed.
 */
export function deriveChartTimelines(messages: Message[]): ChartTimeline[] {
  const byChartId = new Map<string, ChartTimeline>()

  for (const message of messages) {
    if (!isRenderedChartRow(message)) continue
    let raw: unknown
    try {
      raw = JSON.parse(message.toolInput!)
    } catch {
      // Streaming leaves partial JSON on the row until the call completes.
      // It is not a revision yet.
      continue
    }
    const parsed = parseChartToolInput(raw)
    if (!parsed.ok) continue

    // Identity comes from the row's own result, for BOTH operations. An
    // update's `chartId` argument is the model's claim; the result is what the
    // main process actually committed. Using the result for both means a
    // hallucinated or stale chartId cannot graft a revision onto the wrong
    // chart, and the create/update paths share one identity rule.
    const chartId = chartIdOfRow(message)
    if (!chartId) continue

    const request = parsed.request
    if (request.operation === 'update') {
      const timeline = byChartId.get(chartId)
      // An update whose target is not on this branch has nothing to revise —
      // after a rewind past the create, its own row is orphaned.
      if (!timeline) continue
      timeline.revisions.push({
        messageId: message.id,
        spec: request.spec,
        revision: timeline.revisions.length + 1,
      })
      timeline.title = request.spec.title
      timeline.currentMessageId = message.id
      continue
    }

    byChartId.set(chartId, {
      chartId,
      title: request.spec.title,
      revisions: [{ messageId: message.id, spec: request.spec, revision: 1 }],
      currentMessageId: message.id,
    })
  }

  return [...byChartId.values()]
}

/**
 * Index every chart-bearing tool row by what it should render.
 *
 * Returning a map keyed by message id lets the rendering seam ask one question
 * per row — "what does this row show?" — instead of re-deriving the whole
 * conversation per group.
 */
export function chartRowRenders(messages: Message[]): Map<string, ChartRowRender> {
  const renders = new Map<string, ChartRowRender>()
  for (const timeline of deriveChartTimelines(messages)) {
    for (const revision of timeline.revisions) {
      renders.set(
        revision.messageId,
        revision.messageId === timeline.currentMessageId
          ? { kind: 'current', timeline }
          : {
            kind: 'moved',
            chartId: timeline.chartId,
            title: timeline.title,
            targetMessageId: timeline.currentMessageId,
          },
      )
    }
  }
  return renders
}

/**
 * The chart renders owned by one group of tool rows.
 *
 * The transcript groups tool calls, so the visual-output seam receives a
 * group's rows and needs the subset of chart renders they own — derived from
 * the WHOLE message list, because a chart's current revision usually lives in
 * a different group than the one being rendered.
 */
export function chartRendersForRows(
  rows: Message[],
  allMessages: Message[],
): Array<{ messageId: string; render: ChartRowRender }> {
  const renders = chartRowRenders(allMessages)
  const owned: Array<{ messageId: string; render: ChartRowRender }> = []
  for (const row of rows) {
    const render = renders.get(row.id)
    if (render) owned.push({ messageId: row.id, render })
  }
  return owned
}

/** Whether a chart shows revision chrome at all. */
export function hasSeveralRevisions(timeline: ChartTimeline): boolean {
  return timeline.revisions.length > 1
}

/** The status label for one page of a timeline. */
export function revisionStatus(
  timeline: ChartTimeline,
  index: number,
): 'current' | 'outdated' | 'only' {
  if (!hasSeveralRevisions(timeline)) return 'only'
  return index === timeline.revisions.length - 1 ? 'current' : 'outdated'
}
