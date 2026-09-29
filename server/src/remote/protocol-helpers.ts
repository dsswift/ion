/**
 * Pure transform helper: NormalizedEvent → RemoteEvent.
 *
 * Extracted from protocol.ts to keep that file under the 600-line cap.
 * Import directly from here or from the protocol.ts re-export barrel.
 */

import type { NormalizedEvent } from '@ion/shared/types'
import type { RemoteEvent } from './protocol'

/**
 * The session-plane events a thin client receives as events. Everything that
 * becomes a transcript row (text, tools, errors) reaches it on the store's
 * transcript stream instead.
 */
export function normalizedToRemote(tabId: string, event: NormalizedEvent): RemoteEvent | null {
  switch (event.type) {
    case 'task_complete':
      return { type: 'desktop_task_complete', tabId, result: event.result, costUsd: event.costUsd, durationMs: event.durationMs, reason: event.reason }
    case 'permission_request':
      return {
        type: 'desktop_permission_request',
        tabId,
        questionId: event.questionId,
        toolName: event.toolName,
        toolInput: event.toolInput,
        options: event.options,
      }
    default:
      return null
  }
}
