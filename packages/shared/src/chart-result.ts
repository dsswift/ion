/**
 * The chart-identity channel between the chart tool and the transcript.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * A chart's id is minted in the MAIN process from the tool-gate request id
 * (`tool-gate-<nanos>-<seq>`). The renderer never sees that id: a tool row is
 * keyed by the engine's tool-use id (`toolu_…` / `call_…`), which is a
 * completely different identifier.
 *
 * The renderer used to bridge that gap by DERIVING a chart id from the row id
 * with a rule duplicated from the main process. Those two identifiers never
 * match, so an `update` row looked for a timeline that did not exist and was
 * silently dropped: the card never showed a revision badge, and previous/next
 * revision controls never appeared. The unit tests missed it because they fed
 * the same string to both sides, which is exactly the coincidence the real
 * system does not provide.
 *
 * So identity is DATA, not a coincidence. The tool states the chart id in its
 * result text; the engine persists that result verbatim
 * (`SessionLoadMessage` tool content), so the id survives a reload. This
 * module owns both halves of that contract — one builder, one parser — so the
 * format cannot drift between the process that writes it and the one that
 * reads it.
 *
 * ── Why the id lives in prose the model also reads ──────────────────────────
 * The model needs the id to issue an update, so it must be in the result text
 * regardless. Adding a second hidden channel for the same fact would create
 * two things to keep in sync. The marker below is therefore part of the
 * human/model-readable sentence, and `parseChartResultId` is strict about its
 * exact shape so a reworded summary fails the tests rather than silently
 * breaking revision grouping.
 */

/** The literal that precedes a chart id in a tool result. */
const ID_MARKER = 'id: '

/** Characters a chart id is allowed to contain (mirrors the minting rule). */
const CHART_ID_PATTERN = '[A-Za-z0-9_-]+'

/**
 * The one regex that reads an id back out of a result summary.
 *
 * Anchored on the marker and the trailing separator so a chart id can never
 * absorb the following words, and so a summary that drops the marker fails
 * loudly instead of returning a truncated id.
 */
const ID_RE = new RegExp(`${ID_MARKER}(${CHART_ID_PATTERN}) ·`)

/**
 * Build the model-facing result for a committed chart.
 *
 * `create` states the id and tells the model exactly how to revise the chart;
 * `update` reports the new revision depth. Both put the id in the same
 * position so one parser serves both.
 */
export function formatChartResultSummary(opts: {
  operation: 'create' | 'update'
  chartId: string
  title: string
  kind: string
  datasets: number
  points: number
  revision: number
}): string {
  const shape = `${opts.kind} · ${opts.datasets} series · ${opts.points} points`
  const head = `${ID_MARKER}${opts.chartId} · title: "${opts.title}" · ${shape}`
  return opts.operation === 'create'
    ? `Chart rendered in the conversation. ${head}. To revise this exact chart later, call RenderChart with operation "update", chartId "${opts.chartId}", and expectedTitle "${opts.title}".`
    : `Chart updated to revision ${opts.revision}. ${head}. Earlier revisions remain browsable on the card.`
}

/**
 * Read the chart id back out of a persisted tool result.
 *
 * Returns null when the content is not a chart result — a refused call, an
 * empty row mid-stream, or any other tool's output. A null means "this row
 * has no chart identity", which the caller renders as no chart at all rather
 * than guessing.
 */
export function parseChartResultId(content: string | undefined): string | null {
  if (!content) return null
  const match = ID_RE.exec(content)
  return match ? match[1] : null
}
