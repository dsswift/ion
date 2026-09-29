import type { TabState, Message, ConversationInstance } from '@ion/shared/types'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { makeLocalTab, nextMsgId } from '../session-store-helpers'
import { makeMainPane, activeInstance, commitInstance, effectivePermissionMode, effectiveThinkingEffort } from '../conversation-instance'
import { buildRestoredDenied } from './resume-slice-restore-denied'
import { reconcileChartsForBranch } from '../chart-reconcile-request'
import { stageableAttachments } from '@ion/shared/staged-attachments'
import { rError, rInfo } from '../rendererLogger'
import { registerTabOwner } from '../../protocol/tabs-index'
import { closeTab, createTab, engineBroadcastHistory, engineFork, ensureEngineSession, setPermissionMode } from '../host-api'
import { usePreferencesStore } from '../../persistence/preferences'

/**
 * resume-slice-fork — the two fork verbs (`forkTab`, `forkFromMessage`).
 *
 * Extracted from resume-slice.ts to keep both files under the 600-line cap.
 * The seam is the natural one: forking MINTS a new conversation seeded from a
 * live tab's in-memory pane, whereas the rest of resume-slice REHYDRATES a
 * conversation from the engine store or the persisted manifest. The two share
 * only `buildRestoredDenied`, which moved to its own module so neither file
 * has to import the other.
 *
 * Both verbs carry the source conversation's deliberate control settings —
 * permission mode and thinking effort — onto the fork, because a fork
 * continues the source conversation rather than starting a fresh one.
 */

/** Derive the next available "Base (n)" title for a fork of `source`. */
function nextForkTitle(source: TabState, existingTitles: string[]): string {
  const sourceDisplay = source.customTitle || source.title
  const baseMatch = sourceDisplay.match(/^(.+?)\s*\(\d+\)$/)
  const baseName = baseMatch ? baseMatch[1] : sourceDisplay
  let n = 1
  while (existingTitles.includes(`${baseName} (${n})`)) n++
  return `${baseName} (${n})`
}

/** Carry both model value and its explicit-vs-automatic provenance into a fork. */
export function forkModelSelection(
  source: Pick<ConversationInstance, 'modelOverride' | 'modelOverrideSource' | 'modelOverrideProviderId'>,
): Pick<ConversationInstance, 'modelOverride' | 'modelOverrideSource' | 'modelOverrideProviderId'> {
  return {
    modelOverride: source.modelOverride,
    modelOverrideSource: source.modelOverrideSource,
    modelOverrideProviderId: source.modelOverrideProviderId,
  }
}

/** A durable engine entry id is never one of the desktop's optimistic msg ids. */
function durableEntryId(message: Message): string | undefined {
  return message.id.startsWith('msg-') ? undefined : message.id
}

/**
 * Start the source conversation's engine session when it is not running. A
 * conversation restored after a server restart has no session until its
 * first prompt, and the engine forks only from a live session.
 */
async function wakeForkSource(source: TabState, permissionMode: 'auto' | 'plan'): Promise<void> {
  const profile = source.engineProfileId
    ? usePreferencesStore.getState().engineProfiles.find((p) => p.id === source.engineProfileId)
    : null
  const result = await ensureEngineSession({
    tabId: source.id,
    workingDirectory: source.workingDirectory,
    conversationId: source.conversationId,
    permissionMode,
    extensions: profile?.extensions,
  })
  if (!result.ok) throw new Error(`The source conversation could not be started: ${result.error ?? 'unknown error'}`)
}

/**
 * Fork through the engine before publishing any local tab state. The engine
 * copies the plan the source had open into the fork's own folder, so the
 * fork's pane records that copy, never the source's plan. A fork that fails
 * closes the tab it registered, so no empty tab is left behind.
 */
async function createDurableFork(
  source: TabState,
  permissionMode: 'auto' | 'plan',
  target: { messageIndex: number; entryId?: string; userTurnIndex?: number },
): Promise<{ tabId: string; conversationId: string; planFilePath: string | null }> {
  await wakeForkSource(source, permissionMode)
  const { tabId } = await createTab()
  try {
    const result = await engineFork(source.id, tabId, target)
    if (!result.ok || !result.conversationId) {
      throw new Error(result.error || 'The engine did not return a forked conversation ID')
    }
    return { tabId, conversationId: result.conversationId, planFilePath: result.planFilePath ?? null }
  } catch (error) {
    void closeTab(tabId).catch((closeError) => {
      rError('session.fork', 'fork cleanup could not close the unused tab', { tab_id: tabId.slice(0, 8), error: String(closeError) })
    })
    throw error
  }
}

/** Tell the operator, in the source conversation, that the fork did not happen. */
function reportForkFailure(set: StoreSet, sourceTabId: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error)
  set((s) => ({
    conversationPanes: commitInstance(s.conversationPanes, sourceTabId, (inst) => ({
      ...inst,
      messages: [...inst.messages, { id: nextMsgId(), role: 'system' as const, content: `Fork failed: ${reason}`, timestamp: Date.now() }],
    })),
  }))
}

export function createForkSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    forkTab: async (sourceTabId) => {
      const source = get().tabs.find((t) => t.id === sourceTabId)
      if (!source || !source.conversationId) {
        rError('session.fork', 'fork tab rejected because source identity is absent', { source_tab: sourceTabId.slice(0, 8) })
        return null
      }
      // Source scrollback lives on the source tab's active instance now.
      const sourceInst = activeInstance(get().conversationPanes, sourceTabId)
      if (!sourceInst) throw new Error('Cannot fork a tab whose conversation instance is missing')
      try {
        const { tabId, conversationId, planFilePath } = await createDurableFork(source, effectivePermissionMode(source, get().conversationPanes), {
          messageIndex: sourceInst.messages.length - 1,
        })

        const messages: Message[] = sourceInst.messages.map((m) => ({
          ...m,
          id: nextMsgId(),
        }))

        const restoredDenied = buildRestoredDenied(messages)
        const forkTitle = nextForkTitle(source, get().tabs.map((t) => t.customTitle || t.title))

        const tab: TabState = {
          ...makeLocalTab(),
          id: tabId,
          conversationId,
          lastKnownSessionId: conversationId,
          forkedFromSessionId: source.conversationId,
          title: source.title,
          customTitle: forkTitle,
          workingDirectory: source.workingDirectory,
          hasChosenDirectory: source.hasChosenDirectory,
          additionalDirs: [...source.additionalDirs],
          pillColor: source.pillColor,
          // A fork continues the same conversation kind. Dropping this made an
          // extension-hosted fork silently become a Plain tab on its next send.
          engineProfileId: source.engineProfileId,
        }
        if (tab.principalSubject) registerTabOwner(tab.id, tab.principalSubject)
        // Carry the source instance's permission mode and thinking effort onto
        // the new pane instance — a fork continues the source conversation, so
        // it inherits its deliberate control settings.
        const forkMode = effectivePermissionMode(source, get().conversationPanes)
        const forkEffort = effectiveThinkingEffort(source, get().conversationPanes)
        // Seed the forked tab's `main` pane with the carried-over scrollback +
        // restored denial. modelOverride carries from the source instance.
        rInfo('session.fork', 'fork tab', { source_tab: sourceTabId.slice(0, 8), new_tab: tab.id.slice(0, 8), count: messages.length, restored_denied: restoredDenied })
        set((s) => ({
          tabs: [...s.tabs, tab],
          conversationPanes: new Map(s.conversationPanes).set(tab.id, makeMainPane({
            messages,
            messageCount: messages.length,
            historyHydrated: true,
            conversationIds: [conversationId],
            sessions: [{ id: conversationId, reason: 'fork', createdAt: Date.now(), parentId: source.conversationId! }],
            ...forkModelSelection(sourceInst),
            permissionDenied: restoredDenied,
            planFilePath,
            permissionMode: forkMode,
            thinkingEffort: forkEffort,
          })),
          activeTabId: tab.id,
          isExpanded: true,
        }))
        setPermissionMode(tabId, forkMode, 'tab_create')
        reconcileChartsForBranch(tab.id, conversationId, messages)
        void engineBroadcastHistory(tab.id, 'main', { queueUntilTabExists: true }).catch((error) => {
          rError('session.fork', 'fork tab history broadcast failed', { tab_id: tab.id.slice(0, 8), error: String(error) })
        })
        return tabId
      } catch (error) {
        rError('session.fork', 'fork tab failed', { source_tab: sourceTabId.slice(0, 8), error: String(error) })
        reportForkFailure(set, sourceTabId, error)
        return null
      }
    },

    forkFromMessage: async (tabId, messageId) => {
      const source = get().tabs.find((t) => t.id === tabId)
      if (!source) return null
      // Source scrollback lives on the source tab's active instance now.
      const sourceInst = activeInstance(get().conversationPanes, tabId)
      if (!sourceInst) throw new Error('Cannot fork from a tab whose conversation instance is missing')
      const idx = sourceInst.messages.findIndex((m) => m.id === messageId)
      if (idx < 0) return null

      try {
        const targetMessage = sourceInst.messages[idx]
        let userTurnIndex = -1
        for (let i = 0; i <= idx; i++) {
          if (sourceInst.messages[i].role === 'user') userTurnIndex++
        }
        const { tabId: newTabId, conversationId, planFilePath } = await createDurableFork(source, effectivePermissionMode(source, get().conversationPanes), {
          messageIndex: idx - 1,
          entryId: durableEntryId(targetMessage),
          userTurnIndex,
        })
        const messages: Message[] = sourceInst.messages.slice(0, idx).map((m) => ({
          ...m,
          id: nextMsgId(),
        }))

        const restoredDenied = buildRestoredDenied(messages)
        const forkTitle = nextForkTitle(source, get().tabs.map((t) => t.customTitle || t.title))

        const tab: TabState = {
          ...makeLocalTab(),
          id: newTabId,
          conversationId,
          lastKnownSessionId: conversationId,
          forkedFromSessionId: source.conversationId,
          title: source.title,
          customTitle: forkTitle,
          workingDirectory: source.workingDirectory,
          hasChosenDirectory: source.hasChosenDirectory,
          additionalDirs: [...source.additionalDirs],
          pillColor: source.pillColor,
          // A fork continues the same conversation kind. Dropping this made an
          // extension-hosted fork silently become a Plain tab on its next send.
          engineProfileId: source.engineProfileId,
          // pendingInput stays on the tab (one-shot InputBar pre-fill); draftInput
          // is seeded onto the instance below. The forked turn's attachments are
          // restaged with it — a fork that pre-fills the text but drops the
          // images produces a prompt the user cannot resend as it was.
          pendingInput: targetMessage.content,
          attachments: stageableAttachments(targetMessage.attachments),
        }
        if (tab.principalSubject) registerTabOwner(tab.id, tab.principalSubject)
        // Carry the source instance's permission mode and thinking effort onto
        // the new pane instance — a fork continues the source conversation, so
        // it inherits its deliberate control settings.
        const forkMode = effectivePermissionMode(source, get().conversationPanes)
        const forkEffort = effectiveThinkingEffort(source, get().conversationPanes)
        rInfo('session.fork', 'fork from message', { source_tab: tabId.slice(0, 8), new_tab: tab.id.slice(0, 8), count: messages.length, restored_denied: restoredDenied })
        set((s) => ({
          tabs: [...s.tabs, tab],
          conversationPanes: new Map(s.conversationPanes).set(tab.id, makeMainPane({
            messages,
            messageCount: messages.length,
            historyHydrated: true,
            conversationIds: [conversationId],
            sessions: [{ id: conversationId, reason: 'fork', createdAt: Date.now(), parentId: source.conversationId! }],
            ...forkModelSelection(sourceInst),
            permissionDenied: restoredDenied,
            planFilePath,
            draftInput: targetMessage.content,
            permissionMode: forkMode,
            thinkingEffort: forkEffort,
          })),
          activeTabId: tab.id,
          isExpanded: true,
        }))
        setPermissionMode(newTabId, forkMode, 'tab_create')
        reconcileChartsForBranch(tab.id, conversationId, messages)
        void engineBroadcastHistory(tab.id, 'main', { queueUntilTabExists: true }).catch((error) => {
          rError('session.fork', 'fork from message history broadcast failed', { tab_id: tab.id.slice(0, 8), error: String(error) })
        })
        return newTabId
      } catch (error) {
        rError('session.fork', 'fork from message failed', { source_tab: tabId.slice(0, 8), message_id: messageId, error: String(error) })
        reportForkFailure(set, tabId, error)
        return null
      }
    },
  }
}
