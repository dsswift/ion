/**
 * Chart restoration — republishing persisted charts when a session comes up.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The engine stores no resource content: the producer owns persistence and
 * answers for its own items (root AGENTS.md § "Resource subsystem →
 * Producer-owned persistence"). The desktop is the producer for `chart`, and
 * it persists every chart to `~/.ion/resources/<conversationId>/chart-*.json`.
 *
 * But persistence alone is invisible. A chart only reaches the attachments
 * panel, the Studio mirror, and iOS as a resource DELTA, and a delta is only
 * emitted when the chart tool runs. So after a desktop restart every chart was
 * still on disk and absent from every surface — the row the operator saw
 * before the restart was simply gone, with nothing in any log to say why.
 *
 * This module closes that gap: when a session subscribes to its resource
 * broker, whatever charts that conversation already has are republished as
 * `create` deltas. The subscriber sees the same items it would have seen had
 * it been listening when they were first drawn.
 *
 * ── Why `create` and not a distinct restore op ──────────────────────────────
 * `applyDelta` upserts by identity, so re-announcing an existing chart is
 * idempotent on every consumer. Inventing a `restore` op would mean teaching
 * three clients a new verb for something they already handle correctly.
 */
import {
  CHART_RESOURCE_KIND,
  chartResourceItem,
  conversationsWithCharts,
  loadChartRecords,
} from './chart-resource-store'
import { publishChartResource, type ChartPublishBridge } from './chart-resource-publish'
import { broadcast } from './broadcast'
import { resourceCatalog } from './resource-catalog'
import { IPC } from '../shared/types'
import { log as _log, warn as _warn } from './logger'

const TAG = 'chart-restore'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Conversations whose charts have already been republished on this run.
 *
 * Keyed by conversation, not by session: a conversation can be re-subscribed
 * (reconnect, a second instance) and its charts must not be re-read from disk
 * every time. Cleared only by a process restart, which is exactly when the
 * republish is needed again.
 */
const restoredConversations = new Set<string>()

/** Forget a conversation's restore state so the next subscribe re-reads disk. */
export function resetChartRestoreState(): void {
  restoredConversations.clear()
}

/**
 * Hydrate the resource catalog with every persisted chart on disk.
 *
 * ── Why this exists, and why subscribe-time restoration is not enough ───────
 * `restoreConversationCharts` republishes a conversation's charts when its
 * SESSION subscribes to the resource broker. That is correct but late: a
 * session subscribes when the engine attaches to it, which in a real log was
 * three minutes and forty seconds after the conversation was opened. The
 * renderer's first catalog read had already returned zero charts, so the
 * attachments panel painted empty and only corrected itself minutes later.
 * The desktop's view-readiness rule is that a panel is complete the moment it
 * renders, not after a round trip.
 *
 * Charts do not need a session to be read: they are files on disk keyed by
 * conversation id, and the resources directory is itself the index of which
 * conversations have any. So the catalog is filled synchronously, before the
 * renderer's first read, with no engine involvement at all.
 *
 * This seeds the CATALOG only — it publishes nothing. Broadcasting deltas for
 * items no client has asked about would be noise; the renderer reads the
 * catalog it was going to read anyway, and now finds the charts already there.
 */
export function hydrateChartCatalogFromDisk(): void {
  const conversations = conversationsWithCharts()
  if (conversations.length === 0) {
    log('chart hydrate: no persisted charts on disk')
    return
  }

  let charts = 0
  for (const conversationId of conversations) {
    let records
    try {
      records = loadChartRecords(conversationId)
    } catch (err) {
      // One unreadable conversation must not cost every other one its charts.
      warn('chart hydrate: conversation unreadable', { conversation_id: conversationId, error: String(err) })
      continue
    }
    for (const record of records) {
      resourceCatalog.applyFullItem(CHART_RESOURCE_KIND, chartResourceItem(record))
      charts += 1
    }
  }

  log('chart hydrate: catalog seeded from disk', {
    conversations: conversations.length,
    charts,
  })
}

/**
 * Republish every persisted chart for a conversation, once per process run.
 *
 * Fire-and-forget by design: the caller is a subscription path that must not
 * block on disk I/O, and a restore failure leaves the charts on disk for the
 * next attempt rather than breaking the session.
 */
export async function restoreConversationCharts(
  bridge: ChartPublishBridge,
  sessionKey: string,
  conversationId: string,
): Promise<void> {
  if (!sessionKey || !conversationId) return
  if (restoredConversations.has(conversationId)) return
  restoredConversations.add(conversationId)

  let records
  try {
    records = loadChartRecords(conversationId)
  } catch (err) {
    // Marked restored above, so clear it: a read failure should be retried on
    // the next subscribe rather than silently skipped for the whole run.
    restoredConversations.delete(conversationId)
    warn('chart restore failed to read records', {
      session_key: sessionKey, conversation_id: conversationId, error: String(err),
    })
    return
  }

  if (records.length === 0) {
    log('chart restore: nothing persisted', { session_key: sessionKey, conversation_id: conversationId })
    return
  }

  for (const record of records) {
    await publishChartResource(bridge, sessionKey, 'create', record)
  }
  // Tell the renderer the catalog changed. Its resource bootstrap is a
  // one-shot read that races this restoration: at boot the catalog is empty
  // because no session has subscribed yet, and nothing re-reads it — so the
  // attachments panel stayed blank until the next chart action happened to
  // produce a live delta. The push makes the authoritative side responsible
  // for announcing the change instead of the renderer guessing when to look.
  broadcast(IPC.RESOURCE_CATALOG_CHANGED)
  log('chart restore: republished persisted charts', {
    session_key: sessionKey,
    conversation_id: conversationId,
    count: records.length,
  })
}
