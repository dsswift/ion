/**
 * Window-local Questions cache — the renderer's synchronized replica of the
 * main-owned QuestionsCoordinator state.
 *
 * Deliberately OUTSIDE useSessionStore: this store contains no business
 * logic, forwards nothing, and never participates in the Studio mirror
 * (broadcast() delivers the same authoritative snapshot to both windows, so
 * each window's cache converges independently). All mutations go through
 * validated main IPC (questionsPatch / questionsAction); the accepted state
 * comes back on the broadcast channel and replaces local state wholesale.
 *
 * Hydration: `hydrateQuestions()` runs once per window at boot (App.tsx /
 * Studio shell) — it pulls the current snapshot so a window opened mid-
 * workflow renders the wizard immediately (view-readiness rule).
 */
import { create } from 'zustand'
import type {
  QuestionsStateSnapshot,
  QuestionsWorkflowState,
} from '../../shared/questions-state'
import { rWarn } from '../rendererLogger'

interface QuestionsCacheState {
  workflows: QuestionsWorkflowState[]
  lastActionResult: QuestionsStateSnapshot['lastActionResult']
  hydrated: boolean
  /** Replace local state with an authoritative main snapshot. */
  replaceFromMain: (snapshot: QuestionsStateSnapshot) => void
}

export const useQuestionsStore = create<QuestionsCacheState>((set) => ({
  workflows: [],
  lastActionResult: undefined,
  hydrated: false,
  replaceFromMain: (snapshot) =>
    set({
      workflows: snapshot.workflows,
      lastActionResult: snapshot.lastActionResult,
      hydrated: true,
    }),
}))

let wired = false

/**
 * Hydrate from main and subscribe to broadcasts. Idempotent per window.
 * Returns the unsubscribe function (unused in practice — the subscription
 * lives for the window's lifetime).
 */
export function hydrateQuestions(): () => void {
  if (wired) return () => {}
  wired = true
  const replace = useQuestionsStore.getState().replaceFromMain
  window.ion
    .questionsGetState()
    .then(replace)
    .catch((err: unknown) => {
      rWarn('questions', 'initial state hydration failed', { error: String(err) })
    })
  return window.ion.onQuestionsState(replace)
}

/**
 * Open (renderable) workflows for one tab, oldest first. Terminal states are
 * excluded — the same rule main's openForSession applies, duplicated
 * read-side because terminal states DO transit the broadcast once (for
 * dismissal animations). Matches by engine-key prefix: extension-hosted
 * sessions key as `tabId:instanceId`.
 */
export function openWorkflowsForTab(
  workflows: QuestionsWorkflowState[],
  tabId: string,
): QuestionsWorkflowState[] {
  return workflows
    .filter((w) => {
      const wfTab = w.sessionKey.includes(':') ? w.sessionKey.slice(0, w.sessionKey.indexOf(':')) : w.sessionKey
      return wfTab === tabId && w.phase !== 'terminal'
    })
    .sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * Number of active guided waits on a tab, read from the synchronized cache
 * without subscribing. Feeds the Inbox rules (pendingAskCount, snooze
 * eligibility, auto-settle guards): an open guided wait is an operator
 * decision pending, so the tab must not snooze or auto-settle under it.
 * Non-reactive by design — the Inbox guards re-evaluate on their own ticks
 * and action attempts, where a getState() read is current enough.
 */
export function activeQuestionsCount(tabId: string): number {
  return openWorkflowsForTab(useQuestionsStore.getState().workflows, tabId).length
}
