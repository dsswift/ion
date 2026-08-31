/**
 * Chart resource publishing — the one path a committed chart takes to reach
 * every subscriber.
 *
 * Separated from the store so the store stays pure filesystem logic (testable
 * with no engine bridge) and separated from the tool so the responder is not
 * the only caller: the history-rebuild path publishes through here too.
 *
 * ── Ordering is the contract ────────────────────────────────────────────────
 * Callers publish only AFTER the store commits. A delta announcing a chart
 * that failed to persist would show a card that vanishes on restart, which is
 * worse than a chart that briefly does not appear.
 *
 * ── Why the generic resource command ────────────────────────────────────────
 * `resource_publish` already fans a delta out to the desktop renderer, the
 * Studio mirror, and iOS. Charts need no new event type; they need an existing
 * transport and one well-formed item.
 *
 * ── Routing is decided by the ITEM, not by a flag ────────────────────────────
 * `dispatchResourcePublish` routes on `resourceItem.conversationId` alone: an
 * empty one goes to the global broker, a set one to the SESSION broker looked
 * up by `cmd.Key` (engine/internal/server/dispatch_resource.go). A chart is
 * conversation-scoped and always carries a conversationId, so the session key
 * must be supplied or the engine finds no broker and refuses the publish.
 * Sending `resourceGlobal: true` does not override this — that field is not
 * consulted by the publish path at all.
 *
 * ── Why the bridge is a parameter, not a module import ──────────────────────
 * Importing the live `engineBridge` from `./state` would run that module's
 * side effects — it constructs the real `EngineBridge` and control plane at
 * import time — for anything that transitively reaches this file. The gate
 * responder is imported by the control plane for a pure config lookup, so a
 * `./state` import here puts a live socket-owning object into that import
 * graph. Taking the bridge as an argument keeps this module a leaf.
 */
import { CHART_RESOURCE_KIND, chartResourceItem, type ChartRecord } from './chart-resource-store'
import { log as _log, warn as _warn } from './logger'

/**
 * The slice of the engine bridge a publish needs.
 *
 * Narrow on purpose: publishing is one request command, and a narrow type is
 * what lets a test supply a plain object instead of a whole engine.
 */
export interface ChartPublishBridge {
  request<T>(
    cmd: string,
    payload?: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string; data?: T }>
}

/** The engine command every chart publish rides. */
const REQUEST_CMD = 'resource_publish'

const TAG = 'chart-publish'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Publish one chart record as a resource delta.
 *
 * `sessionKey` is the engine session the chart belongs to. It is REQUIRED
 * because the item carries a conversationId, which routes the publish to that
 * session's broker; an empty key would leave the engine with no broker to
 * publish through.
 *
 * A publish failure is logged rather than thrown: the chart is already on disk
 * and will be picked up by the next cold load or subscription snapshot, so a
 * transient socket error must not turn a saved chart into a tool error the
 * model reads as "the chart did not render". The failure must still be VISIBLE,
 * which is why the result is inspected below.
 */
export async function publishChartResource(
  bridge: ChartPublishBridge,
  sessionKey: string,
  op: 'create' | 'update',
  record: ChartRecord,
): Promise<void> {
  const item = chartResourceItem(record)
  try {
    // `request` RESOLVES with { ok: false, error } on an engine-side refusal —
    // it does not reject. Logging success without reading `ok` is how a
    // refused publish previously reported itself as "published" while the
    // attachments panel stayed empty.
    const result = await bridge.request(REQUEST_CMD, {
      key: sessionKey,
      resourceKind: CHART_RESOURCE_KIND,
      resourceOp: op,
      resourceItem: item,
    })
    if (!result.ok) {
      warn('chart resource publish refused; record is on disk and will reload', {
        op,
        session_key: sessionKey,
        conversation_id: record.conversationId,
        chart_id: record.chartId,
        error: result.error ?? 'engine refused the publish with no error text',
      })
      return
    }
    log('chart resource published', {
      op,
      session_key: sessionKey,
      conversation_id: record.conversationId,
      chart_id: record.chartId,
      revision: record.revision,
    })
  } catch (err) {
    warn('chart resource publish failed; record is on disk and will reload', {
      op,
      session_key: sessionKey,
      conversation_id: record.conversationId,
      chart_id: record.chartId,
      error: String(err),
    })
  }
}

/**
 * Publish a `delete` for a chart the branch no longer produces.
 *
 * Used by the history rebuild after a rewind: the record is gone from disk, so
 * every subscriber must drop its attachment row rather than keep offering a
 * jump to a revision the branch cannot show.
 */
export async function publishChartResourceRemoval(
  bridge: ChartPublishBridge,
  sessionKey: string,
  conversationId: string,
  chartId: string,
): Promise<void> {
  try {
    const result = await bridge.request(REQUEST_CMD, {
      key: sessionKey,
      resourceKind: CHART_RESOURCE_KIND,
      resourceOp: 'delete',
      resourceItem: {
        id: chartId,
        kind: CHART_RESOURCE_KIND,
        content: '',
        createdAt: '',
        conversationId,
      },
    })
    if (!result.ok) {
      warn('chart resource removal refused', {
        session_key: sessionKey,
        conversation_id: conversationId,
        chart_id: chartId,
        error: result.error ?? 'engine refused the publish with no error text',
      })
      return
    }
    log('chart resource removal published', { conversation_id: conversationId, chart_id: chartId })
  } catch (err) {
    warn('chart resource removal publish failed', {
      conversation_id: conversationId, chart_id: chartId, error: String(err),
    })
  }
}
