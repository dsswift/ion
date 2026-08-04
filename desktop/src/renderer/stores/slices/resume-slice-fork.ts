import type { TabState, Message } from '../../../shared/types'
import type { StoreSet, StoreGet, State } from '../session-store-types'
import { makeLocalTab, nextMsgId } from '../session-store-helpers'
import { makeMainPane, activeInstance, effectivePermissionMode, effectiveThinkingEffort } from '../conversation-instance'
import { buildRestoredDenied } from './resume-slice-restore-denied'
import { rInfo } from '../../rendererLogger'

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

export function createForkSlice(set: StoreSet, get: StoreGet): Partial<State> {
  return {
    forkTab: async (sourceTabId) => {
      const source = get().tabs.find((t) => t.id === sourceTabId)
      if (!source || !source.conversationId) return null
      // Source scrollback lives on the source tab's active instance now.
      const sourceInst = activeInstance(get().conversationPanes, sourceTabId)
      if (!sourceInst) throw new Error('Cannot fork a tab whose conversation instance is missing')
      try {
        const { tabId } = await window.ion.createTab()

        const messages: Message[] = sourceInst.messages.map((m) => ({
          ...m,
          id: nextMsgId(),
        }))

        const restoredDenied = buildRestoredDenied(messages)
        const forkTitle = nextForkTitle(source, get().tabs.map((t) => t.customTitle || t.title))

        const tab: TabState = {
          ...makeLocalTab(),
          id: tabId,
          conversationId: null,
          forkedFromSessionId: source.conversationId,
          title: source.title,
          customTitle: forkTitle,
          workingDirectory: source.workingDirectory,
          hasChosenDirectory: source.hasChosenDirectory,
          additionalDirs: [...source.additionalDirs],
          pillColor: source.pillColor,
          pillIcon: source.pillIcon,
        }
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
            modelOverride: sourceInst.modelOverride,
            permissionDenied: restoredDenied,
            permissionMode: forkMode,
            thinkingEffort: forkEffort,
          })),
          activeTabId: tab.id,
          isExpanded: true,
        }))
        window.ion.setPermissionMode(tabId, forkMode, 'tab_create')
        return tabId
      } catch {
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
        const { tabId: newTabId } = await window.ion.createTab()
        const targetMessage = sourceInst.messages[idx]
        const messages: Message[] = sourceInst.messages.slice(0, idx).map((m) => ({
          ...m,
          id: nextMsgId(),
        }))

        const restoredDenied = buildRestoredDenied(messages)
        const forkTitle = nextForkTitle(source, get().tabs.map((t) => t.customTitle || t.title))

        const tab: TabState = {
          ...makeLocalTab(),
          id: newTabId,
          conversationId: null,
          forkedFromSessionId: source.conversationId,
          title: source.title,
          customTitle: forkTitle,
          workingDirectory: source.workingDirectory,
          hasChosenDirectory: source.hasChosenDirectory,
          additionalDirs: [...source.additionalDirs],
          pillColor: source.pillColor,
          pillIcon: source.pillIcon,
          // pendingInput stays on the tab (one-shot InputBar pre-fill); draftInput
          // is seeded onto the instance below.
          pendingInput: targetMessage.content,
        }
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
            modelOverride: sourceInst.modelOverride,
            permissionDenied: restoredDenied,
            draftInput: targetMessage.content,
            permissionMode: forkMode,
            thinkingEffort: forkEffort,
          })),
          activeTabId: tab.id,
          isExpanded: true,
        }))
        window.ion.setPermissionMode(newTabId, forkMode, 'tab_create')
        return newTabId
      } catch {
        return null
      }
    },
  }
}
