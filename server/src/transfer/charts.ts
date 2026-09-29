/**
 * transfer/charts — a moved conversation's charts in the resource catalog.
 *
 * Charts are files the server writes itself (`<dataDir>/resources/<id>/`),
 * and the catalog is seeded from those files at boot. A transfer moves the
 * files, so the catalog has to follow: the arriving machine lists them at
 * once, and the machine they left stops listing them.
 */
import { CHART_RESOURCE_KIND, chartResourceItem, loadChartRecords } from '../persistence/chart-resource-store'
import { resourceCatalog } from '../engine/resource-catalog'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'transfer.charts'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** Adds the charts an import just wrote to the catalog. */
export function seedImportedCharts(conversationIds: readonly string[]): void {
  let charts = 0
  for (const conversationId of conversationIds) {
    try {
      for (const record of loadChartRecords(conversationId)) {
        resourceCatalog.applyFullItem(CHART_RESOURCE_KIND, chartResourceItem(record))
        charts++
      }
    } catch (err) {
      warn('imported charts unreadable; they appear once the conversation is opened', { conversation_id: conversationId, error: String(err) })
    }
  }
  log('imported charts seeded', { conversations: conversationIds.length, charts })
}

/** Drops the charts of conversations that moved away. */
export function forgetMovedCharts(conversationIds: readonly string[]): void {
  const removed = resourceCatalog.removeConversations(CHART_RESOURCE_KIND, conversationIds)
  log('moved charts dropped from the catalog', { conversations: conversationIds.length, charts: removed })
}
