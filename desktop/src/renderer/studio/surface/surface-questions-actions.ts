/**
 * Questions-surface actions for the Studio Surface store.
 *
 * The Questions tab is a guided-wait surface: it appears when a conversation
 * needs operator input and retires when the workflow completes. Its two
 * transitions carry one concern the rest of the strip does not — remembering
 * what was focused BEFORE it stole focus, so retiring it returns the operator
 * to the tab they were on instead of dumping them on an arbitrary one.
 *
 * Extracted from `surface-store.ts` to keep that file under the size cap. The
 * store keeps the state fields and the wiring; the focus-restore decision
 * lives here where it can be read in one piece.
 */
import { QUESTIONS_SURFACE_ID, type NotificationTab, type PinnableSingletonId, type SurfaceConversationPersisted, type SurfaceTab } from '../../../shared/studio-surface-types'
import { rInfo } from '../../rendererLogger'

/** The slice of surface state these actions read and write. */
interface QuestionsSurfaceState {
  pinnedTabs: PinnableSingletonId[]
  notification: NotificationTab | null
  conversations: Record<string, SurfaceConversationPersisted>
  currentConversationId: string | null
  activeTabId: string | null
  /** Showing a guided wait opens the pane, so projection needs this field. */
  visible: boolean
  questionsConversations: Set<string>
  questionsPriorActive: Record<string, string | null>
}

export interface QuestionsSurfaceDeps<S extends QuestionsSurfaceState> {
  get(): S
  set(partial: Partial<S>): void
  /** Re-derive the visible strip from conversation state. */
  project(state: S): Partial<S>
  visibleTabs(pinnedTabs: readonly PinnableSingletonId[], notification: NotificationTab | null, conversation: SurfaceConversationPersisted): SurfaceTab[]
  emptyConversation(): SurfaceConversationPersisted
}

export interface QuestionsSurfaceActions {
  showQuestionsSurface(tabId: string): void
  retireQuestionsSurface(tabId: string): void
}

export function createQuestionsSurfaceActions<S extends QuestionsSurfaceState>(deps: QuestionsSurfaceDeps<S>): QuestionsSurfaceActions {
  return {
    showQuestionsSurface(tabId) {
      const state = deps.get()
      if (state.questionsConversations.has(tabId)) return
      const questionsConversations = new Set(state.questionsConversations)
      questionsConversations.add(tabId)
      // Remember what was focused so completion can restore it (per
      // conversation; only when Questions is about to steal focus).
      const isCurrent = state.currentConversationId === tabId
      const questionsPriorActive = isCurrent
        ? { ...state.questionsPriorActive, [tabId]: state.activeTabId }
        : state.questionsPriorActive
      const conversations = { ...state.conversations }
      if (isCurrent) {
        const current = conversations[tabId] ?? deps.emptyConversation()
        conversations[tabId] = { ...current, activeTabId: QUESTIONS_SURFACE_ID }
      }
      const next = { ...state, questionsConversations, conversations }
      deps.set({
        ...deps.project(next),
        questionsConversations,
        questionsPriorActive,
        // Open the pane: a guided wait hidden behind a closed canvas looks
        // like a hang. Visibility is live-only (not persisted per the keep
        // mode rules) — setVisible semantics preserved by direct set.
        ...(isCurrent ? { visible: true } : {}),
      } as Partial<S>)
      rInfo('studio.surface', 'questions surface shown', { tab_id: tabId, focused: isCurrent })
    },

    retireQuestionsSurface(tabId) {
      const state = deps.get()
      if (!state.questionsConversations.has(tabId)) return
      const questionsConversations = new Set(state.questionsConversations)
      questionsConversations.delete(tabId)
      const prior = state.questionsPriorActive[tabId]
      const questionsPriorActive = { ...state.questionsPriorActive }
      delete questionsPriorActive[tabId]
      const conversations = { ...state.conversations }
      const current = conversations[tabId]
      if (current && current.activeTabId === QUESTIONS_SURFACE_ID) {
        // Restore the pre-Questions focus when still valid; otherwise the
        // normal normalization fallback picks the first composed tab.
        const composed = deps.visibleTabs(state.pinnedTabs, state.notification, current)
        const restored = prior && composed.some((tab) => tab.id === prior) ? prior : (composed[0]?.id ?? null)
        conversations[tabId] = { ...current, activeTabId: restored }
      }
      deps.set({
        ...deps.project({ ...state, questionsConversations, conversations }),
        questionsConversations,
        questionsPriorActive,
      } as Partial<S>)
      rInfo('studio.surface', 'questions surface retired', { tab_id: tabId, restored: prior ?? '' })
    },
  }
}
