/**
 * Chart attachment projection — reading a chart resource in the renderer.
 *
 * The main process stores a chart's current state as a resource whose
 * `content` is JSON. The renderer needs three facts from it to draw an
 * attachment row: the title to show, the revision to badge, and the tool row
 * to navigate to.
 *
 * Parsing is defensive and returns null rather than throwing: a chart written
 * by a newer Ion, or a record damaged on disk, must degrade to "not listed"
 * rather than breaking the attachments panel for every other item in it.
 */
import type { ResourceItem } from '../../shared/types-engine'

/** The resource kind charts publish under. Mirrors the main-process constant. */
export const CHART_RESOURCE_KIND = 'chart'

export interface ChartAttachmentEntry {
  chartId: string
  title: string
  /** 1-based; only badged when greater than 1. */
  revision: number
  /** Tool-row id of the current revision — the navigation target. */
  toolMessageId: string
}

/**
 * Read a chart resource item into an attachment row.
 *
 * Metadata is preferred over `content` because the desktop→iOS snapshot
 * carries metadata without full content; reading the same fields from the same
 * place on both paths keeps the two surfaces consistent. `content` is the
 * fallback for a locally-published item that arrived with its body inline.
 */
export function parseChartResourceItem(item: ResourceItem): ChartAttachmentEntry | null {
  if (item.kind !== CHART_RESOURCE_KIND || !item.id) return null

  const metaRevision = item.metadata?.chartRevision
  const metaAnchor = item.metadata?.chartToolMessageId
  let revision = typeof metaRevision === 'number' && Number.isInteger(metaRevision) && metaRevision >= 1
    ? metaRevision
    : 0
  let toolMessageId = typeof metaAnchor === 'string' ? metaAnchor : ''
  let title = item.title ?? ''

  if (!revision || !toolMessageId || !title) {
    if (!item.content) return null
    try {
      const body = JSON.parse(item.content) as Record<string, unknown>
      if (!revision && typeof body.revision === 'number' && Number.isInteger(body.revision)) {
        revision = body.revision
      }
      if (!toolMessageId && typeof body.toolMessageId === 'string') {
        toolMessageId = body.toolMessageId
      }
      if (!title && typeof body.title === 'string') title = body.title
    } catch {
      // A damaged record must not remove every other attachment from the
      // panel, so it is simply not listed.
      return null
    }
  }

  if (!title || !toolMessageId || revision < 1) return null
  return { chartId: item.id, title, revision, toolMessageId }
}
