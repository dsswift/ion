import type { Message } from '../../shared/types'
import { useSessionStore } from '../stores/sessionStore'
import { setSavedBuffer } from '../components/TerminalInstance'
import { commitInstance, activeInstance } from '../stores/conversation-instance'
import { lastPendingCardTool } from '../../shared/pending-card'
import { mapSessionHistory } from '../../shared/session-message-mapper'
import { parseToolInput, isSkeletonTab } from './useTabRestoration-helpers'
import { rDebug } from '../rendererLogger'
import type { PersistedTabState } from '../../shared/types-persistence'

/**
 * useTabRestoration-history — the history-loading phase of tab restoration.
 *
 * Extracted from useTabRestoration.ts to keep both files under the 600-line
 * cap, following the existing `-helpers` / `-sessions` / `-engine` sibling
 * pattern. This is one discrete phase with a clear precondition and
 * postcondition: every restored tab already exists in the store, and this fills
 * in scrollback for the ones whose history lives in the engine conversation
 * store. Skeleton tabs are skipped — their history loads lazily on first
 * activation via loadSkeletonMessages.
 */
export async function loadRestoredHistory(
  saved: PersistedTabState,
  restoredTabIds: Array<{ tabId: string; sessionId: string | null; index: number }>,
): Promise<void> {
useSessionStore.setState({ initProgress: 'Loading history…' })
// Load historical session messages for tabs that have them
// Skip skeleton tabs — their history loads on-demand via loadSkeletonMessages
for (const { tabId, index } of restoredTabIds) {
  if (isSkeletonTab(useSessionStore.getState().conversationPanes, tabId)) continue

  const st = saved.tabs[index]
  const historicalIds = st.historicalSessionIds || []
  if (historicalIds.length > 0) {
    const allHistoricalMessages: Message[] = []
    for (const hid of historicalIds) {
      const history = await window.ion.loadSession(hid, st.workingDirectory).catch(() => [])
      const msgs = mapSessionHistory(history, () => crypto.randomUUID())
      allHistoricalMessages.push(...msgs)
    }

    if (allHistoricalMessages.length > 0) {
      // If tab has no active session and combined messages end with
      // ExitPlanMode/AskUserQuestion, restore the plan card so the
      // user can re-implement without hunting through history.
      // Messages + permissionDenied now live on the `main` instance.
      const tab = useSessionStore.getState().tabs.find((t) => t.id === tabId)
      const inst = activeInstance(useSessionStore.getState().conversationPanes, tabId)
      const combinedMessages = [...allHistoricalMessages, ...(inst?.messages ?? [])]
      let restoredDenied = inst?.permissionDenied ?? null
      if (!restoredDenied && !tab?.conversationId) {
        // Shared pending-card rule: restore only when the last
        // AskUserQuestion / ExitPlanMode is still outstanding (no
        // trailing /clear divider, no trailing user message).
        const found = lastPendingCardTool(combinedMessages)
        if (found) {
          restoredDenied = { tools: [{ toolName: found.toolName, toolUseId: found.toolId || 'restored', toolInput: parseToolInput(found.toolInput) }] }
        } else {
          rDebug('restore', 'no pending card restored', { tab_id: tabId.slice(0, 8) })
        }
      }

      // Prepend historical messages onto the instance scrollback and
      // (optionally) seed the restored denial card — both on the
      // `main` instance via commitInstance in a single set.
      useSessionStore.setState((s) => ({
        conversationPanes: commitInstance(s.conversationPanes, tabId, (i) => ({
          ...i,
          messages: [...allHistoricalMessages, ...i.messages],
          ...(restoredDenied ? { permissionDenied: restoredDenied } : {}),
        })),
      }))
    }
  }
}

// Fallback: recover messages from lastKnownSessionId when both
// conversationId and historicalSessionIds are empty
// Skip skeleton tabs — they defer all message loading to on-demand
for (const { tabId, index } of restoredTabIds) {
  if (isSkeletonTab(useSessionStore.getState().conversationPanes, tabId)) continue

  const st = saved.tabs[index]
  const historicalIds = st.historicalSessionIds || []
  if (!st.conversationId && historicalIds.length === 0 && st.lastKnownSessionId) {
    const history = await window.ion.loadSession(st.lastKnownSessionId, st.workingDirectory).catch(() => [])
    if (history.length > 0) {
      const msgs = mapSessionHistory(history, () => crypto.randomUUID())
      // Prepend recovered messages onto the `main` instance scrollback.
      useSessionStore.setState((s) => ({
        conversationPanes: commitInstance(s.conversationPanes, tabId, (i) => ({
          ...i,
          messages: [...msgs, ...i.messages],
        })),
      }))
    }
  }
}

// Restore terminal pane instances for non-terminal-only tabs
for (const { tabId, index } of restoredTabIds) {
  const st = saved.tabs[index]
  if (!st.isTerminalOnly && st.terminalInstances && st.terminalInstances.length > 0) {
    const panes = new Map(useSessionStore.getState().terminalPanes)
    panes.set(tabId, {
      instances: st.terminalInstances,
      activeInstanceId: st.terminalInstances[0].id,
    })
    useSessionStore.setState({ terminalPanes: panes })
    // Pre-populate saved buffers for history restore
    if (st.terminalBuffers) {
      for (const inst of st.terminalInstances) {
        const buf = st.terminalBuffers[inst.id]
        if (buf) setSavedBuffer(`${tabId}:${inst.id}`, buf)
      }
    }
  }
}
}
