/**
 * The chart-index reconciliation IPC handler.
 *
 * Split from `ipc/engine.ts` so that file keeps its single concern (engine
 * session verbs) and stays under the size cap. The channel lives beside the
 * engine verbs conceptually — it fires immediately after a rewind, which is an
 * engine operation — but its payload validation and publish plumbing are its
 * own body of work.
 *
 * ── Why the payload is validated here ───────────────────────────────────────
 * `ipcMain.on` is an untrusted-input boundary like every other. The rows arrive
 * from a renderer as arbitrary JSON, and a malformed row reaching
 * `rebuildFromHistory` would either throw inside the history flow or, worse,
 * rebuild an index from partial data and DELETE the records the branch could
 * not account for. So the shape is checked first, and a request that fails the
 * check is refused loudly rather than partially applied.
 */
import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log, warn as _warn } from '../logger'
import { engineBridge } from '../state'
import { reconcileConversationCharts } from '../chart-reconcile'
import type { ChartHistoryRow } from '../chart-resource-store'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('chart-reconcile', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('chart-reconcile', msg, fields)
}

/**
 * Upper bound on rows accepted in one reconciliation.
 *
 * A conversation's chart rows are a small subset of its transcript, so this is
 * a guard against a malformed or hostile payload rather than a product limit:
 * a conversation with more than this many chart calls is not a chart index,
 * and rebuilding from it would be a long synchronous disk pass.
 */
const MAX_RECONCILE_ROWS = 500

/** Max characters accepted for one row's tool input or result text. */
const MAX_ROW_FIELD_CHARS = 200_000

/**
 * Narrow an untrusted payload to the rows the rebuild accepts.
 *
 * Returns null when the request is not shaped like a reconciliation at all —
 * the caller refuses rather than reconciling from a partial list, because a
 * short list is indistinguishable from "the branch lost these charts" and
 * would delete real records.
 */
export function parseReconcileRequest(payload: unknown): {
  tabId: string
  conversationId: string
  rows: ChartHistoryRow[]
} | null {
  if (typeof payload !== 'object' || payload === null) return null
  const request = payload as Record<string, unknown>
  const tabId = typeof request.tabId === 'string' ? request.tabId : ''
  const conversationId = typeof request.conversationId === 'string' ? request.conversationId : ''
  if (!tabId || !conversationId) return null
  if (!Array.isArray(request.rows)) return null
  if (request.rows.length > MAX_RECONCILE_ROWS) return null

  const rows: ChartHistoryRow[] = []
  for (const candidate of request.rows) {
    if (typeof candidate !== 'object' || candidate === null) return null
    const row = candidate as Record<string, unknown>
    const toolMessageId = row.toolMessageId
    const toolInput = row.toolInput
    const resultText = row.resultText
    const index = row.index
    if (typeof toolMessageId !== 'string' || toolMessageId.length === 0) return null
    if (typeof toolInput !== 'string' || toolInput.length > MAX_ROW_FIELD_CHARS) return null
    if (typeof resultText !== 'string' || resultText.length > MAX_ROW_FIELD_CHARS) return null
    if (typeof index !== 'number' || !Number.isFinite(index)) return null
    rows.push({ toolMessageId, toolInput, resultText, index })
  }
  return { tabId, conversationId, rows }
}

/**
 * Wire the reconciliation channel.
 *
 * The session key is the tab id (ADR-010 bare-key conversations), which is what
 * routes the conversation-scoped publish to the right broker.
 */
export function registerChartReconcileIpc(): void {
  ipcMain.on(IPC.CHART_RECONCILE, (_event, payload: unknown) => {
    const request = parseReconcileRequest(payload)
    if (!request) {
      warn('chart reconcile refused — malformed request')
      return
    }
    log('chart reconcile requested', {
      tab_id: request.tabId,
      conversation_id: request.conversationId,
      rows: request.rows.length,
    })
    void reconcileConversationCharts(
      engineBridge,
      request.tabId,
      request.conversationId,
      request.rows,
    ).catch((err: unknown) => {
      warn('chart reconcile failed', {
        tab_id: request.tabId,
        conversation_id: request.conversationId,
        error: String(err),
      })
    })
  })
}
