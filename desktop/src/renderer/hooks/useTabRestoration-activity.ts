/**
 * backfillLastMessageAt — restore the exact inbox timestamp from the durable
 * conversation stream. Only user/assistant rows count. A machine-authored
 * user injection is excluded using the engine's persisted classification.
 */
import { useSessionStore } from '../stores/sessionStore'
import { rDebug, rWarn } from '../rendererLogger'
import { suppressesInjection } from '../../shared/injection-policy'
import type { SessionLoadMessage } from '../../shared/types'

export function newestConversationMessageAt(messages: readonly SessionLoadMessage[]): number | null {
  let newest: number | null = null
  for (const message of messages) {
    const isRealUser = message.role === 'user' && !suppressesInjection(message)
    const isAssistant = message.role === 'assistant'
    if ((isRealUser || isAssistant) && Number.isFinite(message.timestamp)) {
      newest = newest == null ? message.timestamp : Math.max(newest, message.timestamp)
    }
  }
  return newest
}

export function resolveBackfilledMessageAt(persisted: number | null | undefined, history: number | null): number | null {
  if (persisted == null) return history
  if (history == null) return persisted
  return Math.max(persisted, history)
}

/** @deprecated use resolveBackfilledMessageAt for inbox timestamps. */
export const resolveBackfilledActivity = resolveBackfilledMessageAt

export async function backfillLastActivity(): Promise<void> {
  const { tabs } = useSessionStore.getState()
  const candidates = tabs.filter((tab) => tab.conversationId || tab.lastKnownSessionId || tab.historicalSessionIds.length > 0)
  let patched = 0
  await Promise.all(candidates.map(async (tab) => {
    const ids = [...tab.historicalSessionIds, tab.conversationId ?? tab.lastKnownSessionId].filter((id): id is string => !!id)
    try {
      const history = await window.ion.loadChainHistory(ids)
      const fromHistory = newestConversationMessageAt(history)
      useSessionStore.setState((state) => {
        const tabs = state.tabs.map((current) => {
          if (current.id !== tab.id) return current
          const lastMessageAt = resolveBackfilledMessageAt(current.lastMessageAt, fromHistory)
          if (lastMessageAt === current.lastMessageAt) return current
          patched++
          return { ...current, lastMessageAt }
        })
        return { tabs }
      })
    } catch (error) {
      rWarn('message-time', 'history timestamp backfill failed', { tab_id: tab.id.slice(0, 8), error: String(error) })
    }
  }))
  rDebug('message-time', 'inbox message timestamp backfill complete', { tab_count: candidates.length, patched })
}
