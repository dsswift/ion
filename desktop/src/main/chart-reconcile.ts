/**
 * Chart index reconciliation — bringing the durable index back in line with a
 * conversation's ACTIVE BRANCH after its history changed.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * `chart-resource-store` derives current chart state from the tool rows a
 * branch can see, which is what makes rewind and fork correct. But a rebuild
 * that nothing calls changes nothing: after a rewind the persisted record and
 * the attachments row still named a revision the branch had abandoned, while
 * the transcript (which derives live from the visible messages) correctly
 * showed the older card. The two disagreed, and the panel's jump target was a
 * revision the operator could no longer reach.
 *
 * This module is the seam between the two: rebuild from the branch, then
 * publish exactly the deltas that moved.
 *
 * ── Why only the changed records are published ──────────────────────────────
 * `rebuildFromHistory` partitions its result into created / updated / retained
 * / removed. A retained record is byte-identical to what every subscriber
 * already holds, so republishing it would fan a no-op create to the Overlay,
 * the Studio mirror, and iOS on every reconciliation. Publishing the partition
 * means a rewind that touched one chart produces one delta.
 */
import {
  rebuildFromHistory,
  type ChartHistoryRow,
  type ChartRebuildOutcome,
} from './chart-resource-store'
import {
  publishChartResource,
  publishChartResourceRemoval,
  type ChartPublishBridge,
} from './chart-resource-publish'
import { log as _log, warn as _warn } from './logger'

const TAG = 'chart-reconcile'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** What one reconciliation did, for the caller's log line and its tests. */
export interface ChartReconcileResult {
  created: number
  updated: number
  retained: number
  removed: number
}

/**
 * Rebuild a conversation's chart index from its active branch and publish the
 * resulting deltas.
 *
 * `sessionKey` is REQUIRED: a chart item carries a conversationId, which routes
 * its publish to that session's broker. Reconciling without a key would persist
 * the corrected index and then fail every publish, leaving subscribers showing
 * the abandoned revision until the next cold load.
 */
export async function reconcileConversationCharts(
  bridge: ChartPublishBridge,
  sessionKey: string,
  conversationId: string,
  rows: ChartHistoryRow[],
): Promise<ChartReconcileResult> {
  const empty: ChartReconcileResult = { created: 0, updated: 0, retained: 0, removed: 0 }
  if (!conversationId) {
    warn('chart reconcile skipped: no conversation id', { session_key: sessionKey, rows: rows.length })
    return empty
  }
  if (!sessionKey) {
    warn('chart reconcile skipped: no session key', { conversation_id: conversationId, rows: rows.length })
    return empty
  }

  let outcome: ChartRebuildOutcome
  try {
    outcome = rebuildFromHistory(conversationId, rows)
  } catch (err) {
    // A rebuild failure leaves the previous index on disk. That is stale but
    // readable; throwing here would break the caller's history flow instead.
    warn('chart reconcile rebuild failed', {
      session_key: sessionKey, conversation_id: conversationId,
      rows: rows.length, error: String(err),
    })
    return empty
  }

  for (const record of outcome.created) {
    await publishChartResource(bridge, sessionKey, 'create', record)
  }
  for (const record of outcome.updated) {
    await publishChartResource(bridge, sessionKey, 'update', record)
  }
  for (const chartId of outcome.removed) {
    await publishChartResourceRemoval(bridge, sessionKey, conversationId, chartId)
  }

  const result: ChartReconcileResult = {
    created: outcome.created.length,
    updated: outcome.updated.length,
    retained: outcome.retained.length,
    removed: outcome.removed.length,
  }
  log('chart index reconciled to branch', {
    session_key: sessionKey,
    conversation_id: conversationId,
    rows: rows.length,
    ...result,
  })
  return result
}
