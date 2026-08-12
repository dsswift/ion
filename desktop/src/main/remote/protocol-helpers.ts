/**
 * Pure transform helpers: NormalizedEvent → RemoteEvent.
 *
 * Extracted from protocol.ts to keep that file under the 600-line cap.
 * Import directly from here or from the protocol.ts re-export barrel.
 */

import type { NormalizedEvent } from '../../shared/types'
import type { RemoteEvent } from './protocol'

// ─── Helper: convert NormalizedEvent to RemoteEvent ───

export function normalizedToRemote(tabId: string, event: NormalizedEvent): RemoteEvent | null {
  switch (event.type) {
    case 'text_chunk':
      return { type: 'desktop_text_chunk', tabId, text: event.text }
    case 'tool_call':
      return { type: 'desktop_tool_call', tabId, toolName: event.toolName, toolId: event.toolId }
    case 'tool_result':
      return { type: 'desktop_tool_result', tabId, toolId: event.toolId, content: event.content, isError: event.isError }
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
    case 'error':
      return { type: 'desktop_error', tabId, message: event.message }
    default:
      return null
  }
}

// ─── Helper: convert NormalizedEvent to structured message events ───

export function normalizedToMessages(tabId: string, event: NormalizedEvent): RemoteEvent | null {
  switch (event.type) {
    case 'text_chunk':
      // Text chunks update the last assistant message (handled by caller that tracks message state)
      return null
    case 'tool_call':
      return {
        type: 'desktop_message_added',
        tabId,
        message: {
          id: event.toolId,
          role: 'tool',
          content: '',
          toolName: event.toolName,
          toolId: event.toolId,
          toolStatus: 'running',
          timestamp: Date.now(),
        },
      }
    case 'tool_result': {
      const content = event.content.length > 2048
        ? event.content.substring(0, 2048) + '\n... [truncated]'
        : event.content
      return {
        type: 'desktop_message_updated',
        tabId,
        messageId: event.toolId,
        content,
        toolStatus: event.isError ? 'error' : 'completed',
      }
    }
    default:
      return null
  }
}
