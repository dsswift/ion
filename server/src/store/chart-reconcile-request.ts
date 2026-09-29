/**
 * Chart-index reconciliation, triggered from the store's branch-changing
 * slices (rewind, fork, resume).
 *
 * The store holds the AUTHORITATIVE active-branch message list: after a
 * rewind it is the truncated list, and on a fork it is the copied prefix.
 * `reconcileConversationCharts` owns the durable index but has no view of
 * which branch a conversation is on, so the rows travel from here.
 *
 * Runs in-process: the store and the chart index live in the same process
 * now, so this calls `reconcileConversationCharts` directly rather than
 * round-tripping through an IPC channel the way the renderer-owned store
 * once had to.
 */
import { CHART_TOOL_NAME } from '@ion/shared/chart-schema'
import { reconcileConversationCharts } from './chart-reconcile'
import { engineBridge } from '../state'
import { log as _log } from '../logger'
import type { Message } from '@ion/shared/types'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('conversation.chart', msg, fields)
}

/** One completed chart row, in the shape the rebuild accepts. */
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
 * Rebuild a conversation's chart index from this branch and publish exactly
 * the deltas that moved.
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
  log('requesting chart index reconcile', {
    tab_id: tabId.slice(0, 8),
    conversation_id: conversationId,
    rows: rows.length,
  })
  void reconcileConversationCharts(engineBridge, tabId, conversationId, rows)
}
