import type { StoreGet, StoreSet, State } from '../session-store-types'
import { isPersistedSettled } from '@ion/shared/tab-predicates'
import { DEFAULT_RESUME_PROMPT, DEFERRED_RELEASES, usageLimitedUntil, type DeferredRelease } from '@ion/shared/usage-limit'
import { usePreferencesStore } from '../../persistence/preferences'
import { rInfo, rWarn } from '../rendererLogger'

const TAG = 'usage-limit'

/**
 * Owner-durable actions for a conversation its account's usage limit has
 * stopped, and for the prompt the server holds for it until later.
 */
export function createUsageLimitSlice(set: StoreSet, get: StoreGet): Pick<State, 'deferSend' | 'resumeAtLimitReset' | 'cancelDeferredSend' | 'releaseDeferredSend' | 'snoozeUntilLimitReset'> {
  return {
    deferSend: (tabId, text, release) => {
      const tab = get().tabs.find((candidate) => candidate.id === tabId)
      const prompt = text.trim()
      if (!tab || !prompt || !DEFERRED_RELEASES.includes(release)) {
        rWarn(TAG, 'held prompt refused: no conversation, no text, or an unknown release', { tab_id: tabId.slice(0, 8), release, has_text: prompt.length > 0 })
        return false
      }
      if (tab.isTerminalOnly || tab.inputLocked || isPersistedSettled(tab)) {
        rWarn(TAG, 'held prompt refused: the conversation takes no input', { tab_id: tabId.slice(0, 8), release })
        return false
      }
      if (release === 'limit-reset' && usageLimitedUntil(tab, Date.now()) === null) {
        rWarn(TAG, 'held prompt refused: no usage limit holds this conversation', { tab_id: tabId.slice(0, 8) })
        return false
      }
      const queuedAt = Date.now()
      set((state) => ({ tabs: state.tabs.map((candidate) => candidate.id === tabId ? { ...candidate, deferredSend: { text: prompt, release: release as DeferredRelease, queuedAt } } : candidate) }))
      rInfo(TAG, 'prompt held for later', { tab_id: tabId.slice(0, 8), release, replaced: tab.deferredSend != null, length: prompt.length })
      return true
    },

    resumeAtLimitReset: (tabId) => {
      // What a resume sends is this server's setting, so every client asks
      // for the same thing and none needs to know the prompt.
      const prompt = usePreferencesStore.getState().usageLimitResumePrompt.trim() || DEFAULT_RESUME_PROMPT
      return get().deferSend(tabId, prompt, 'limit-reset')
    },

    cancelDeferredSend: (tabId) => {
      const held = get().tabs.find((candidate) => candidate.id === tabId)?.deferredSend
      if (!held) return
      set((state) => ({ tabs: state.tabs.map((candidate) => candidate.id === tabId ? { ...candidate, deferredSend: null } : candidate) }))
      rInfo(TAG, 'held prompt cancelled', { tab_id: tabId.slice(0, 8), release: held.release })
    },

    releaseDeferredSend: (tabId) => {
      const tab = get().tabs.find((candidate) => candidate.id === tabId)
      const held = tab?.deferredSend
      if (!tab || !held) return false
      // Cleared first: the submit below is a real user turn, and a prompt that
      // was sent must never be sent again by the next sweep.
      set((state) => ({ tabs: state.tabs.map((candidate) => candidate.id === tabId ? { ...candidate, deferredSend: null, usageLimit: held.release === 'limit-reset' ? null : candidate.usageLimit } : candidate) }))
      const result = get().submit(tabId, held.text, { publishUserTurn: true })
      if (!result.accepted) {
        // Not sent, so it is still owed: put it back for the next sweep.
        set((state) => ({ tabs: state.tabs.map((candidate) => candidate.id === tabId ? { ...candidate, deferredSend: held, usageLimit: tab.usageLimit } : candidate) }))
        rWarn(TAG, 'held prompt not sent, kept for the next try', { tab_id: tabId.slice(0, 8), release: held.release, reason: result.reason })
        return false
      }
      rInfo(TAG, 'held prompt sent', { tab_id: tabId.slice(0, 8), release: held.release, held_ms: Date.now() - held.queuedAt })
      return true
    },

    snoozeUntilLimitReset: (tabId) => {
      const tab = get().tabs.find((candidate) => candidate.id === tabId)
      const until = tab ? usageLimitedUntil(tab, Date.now()) : null
      if (until === null) {
        rWarn(TAG, 'snooze until reset refused: no usage limit holds this conversation', { tab_id: tabId.slice(0, 8) })
        return
      }
      get().snoozeTab(tabId, until)
    },
  }
}
