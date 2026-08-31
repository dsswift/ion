/**
 * The renderer's half of chart-index reconciliation.
 *
 * ── Why the renderer supplies the rows ──────────────────────────────────────
 * The store holds the AUTHORITATIVE active-branch message list: after a rewind
 * it is the truncated list, and on a fork it is the copied prefix. Main owns
 * the durable index but has no view of which branch a conversation is on, so
 * the rows travel and the rebuild stays where the files are.
 *
 * ── Why the result text travels with the input ──────────────────────────────
 * A chart's identity is stated in its tool RESULT (`chart-result.ts`), never in
 * the row id: the id a row carries is the engine's tool-use id, while a chart
 * id is minted from the tool-gate request id. Sending the input alone would let
 * main rebuild a different set of charts than the ones the tool committed.
 */
import { CHART_TOOL_NAME } from '../components/conversation/chart-revisions'
import { rDebug } from '../rendererLogger'
import type { Message } from '../../shared/types'

/** One completed chart row, in the shape main's rebuild accepts. */
export interface ChartReconcileRow {
  toolMessageId: string
  toolInput: string
  resultText: string
  index: number
}

/**
 * Collect the completed `RenderChart` rows a branch can see.
 *
 * Mirrors `isRenderedChartRow` in chart-revisions.ts: a running row has no
 * committed result yet, and a failed row must never be able to change which
 * chart is current — the chart it did not produce never existed.
 */
export function collectChartRows(messages: Message[]): ChartReconcileRow[] {
  const rows: ChartReconcileRow[] = []
  messages.forEach((message, index) => {
    if (message.role !== 'tool') return
    if (message.toolName !== CHART_TOOL_NAME) return
    if (message.toolStatus === 'running' || message.toolStatus === 'error') return
    if (!message.toolInput) return
    rows.push({
      toolMessageId: message.id,
      toolInput: message.toolInput,
      resultText: message.content ?? '',
      index,
    })
  })
  return rows
}

/**
 * Ask main to rebuild a conversation's chart index from this branch.
 *
 * Called only AFTER the branch change is committed locally, so the rows
 * describe the branch every surface is about to show. A conversation with no
 * durable id yet is skipped: its charts cannot be published to a broker that
 * does not exist, and the fork path re-runs this once the engine mints one.
 */
export function reconcileChartsForBranch(
  tabId: string,
  conversationId: string | null | undefined,
  messages: Message[],
): void {
  if (!conversationId) return
  const rows = collectChartRows(messages)
  rDebug('conversation.chart', 'requesting chart index reconcile', {
    tab_id: tabId.slice(0, 8),
    conversation_id: conversationId,
    rows: rows.length,
  })
  window.ion.reconcileCharts({ tabId, conversationId, rows })
}
