/**
 * Conversation selection for the Studio Surface.
 *
 * Extracted from `surface-store.ts` to keep that file under the size cap. This
 * is the one transition that has to reconcile three things at once — the saved
 * per-conversation focus, the operator's visibility mode, and whether the
 * conversation owes an answer — which is why it does not fit the ordinary
 * update-one-conversation shape the rest of the store uses.
 */
import { QUESTIONS_SURFACE_ID, type NotificationTab, type PinnableSingletonId, type SurfaceConversationPersisted } from '../../../shared/studio-surface-types'
import { usePreferencesStore } from '../../preferences'
import { rDebug } from '../../rendererLogger'

interface SelectionState {
  hydrated: boolean
  currentConversationId: string | null
  conversations: Record<string, SurfaceConversationPersisted>
  notification: NotificationTab | null
  pinnedTabs: PinnableSingletonId[]
  questionsConversations: Set<string>
  visible: boolean
}

let deps: {
  project<S extends SelectionState>(state: S): Partial<S>
  emptyConversation(): SurfaceConversationPersisted
} | null = null

/** Install the store helpers this module composes over. Called once at boot. */
export function configureConversationSelection(next: NonNullable<typeof deps>): void {
  deps = next
}

/** 'per-conversation' restores each conversation's saved pane visibility. */
function shouldRememberVisibility(): boolean {
  return usePreferencesStore.getState().studioSurfaceSwitchMode === 'per-conversation'
}

/** Switch the Surface to a conversation, restoring or defaulting its focus. */
export function applyConversationSelection<S extends SelectionState>(
  set: (partial: Partial<S>) => void,
  get: () => S,
  currentConversationId: string | null,
): void {
  if (!deps) return
  const { project, emptyConversation } = deps
    const state = get()
    const saved = currentConversationId ? state.conversations[currentConversationId]?.visible ?? false : false
    // In 'keep' mode the live panel state carries across a switch — EXCEPT
    // before hydration, when `state.visible` is still the store's `false`
    // default rather than anything the operator chose. The conversation-sync
    // subscription fires at boot ahead of hydrate(), so trusting it there
    // overwrote the restored value and the panel always came back closed.
    let visible = shouldRememberVisibility() || !state.hydrated ? saved : state.visible

    // Entering a conversation that owes the operator an answer ALWAYS lands on
    // the Questions tab with the pane open, whatever the saved per-conversation
    // focus or visibility mode said. A parked question is the one surface the
    // run cannot continue without, and restoring "whatever was focused last
    // time" hid it behind a Diff or Explorer tab — the operator then sees an
    // idle conversation with no indication it is waiting on them.
    //
    // This is a re-entry default, not a lock: once here, they may switch to
    // any other tab freely (nothing re-forces focus while they stay), and the
    // next re-entry defaults to Questions again while the question is still
    // outstanding.
    const conversations = { ...state.conversations }
    const owesAnswer = !!currentConversationId && state.questionsConversations.has(currentConversationId)
    if (owesAnswer && currentConversationId) {
      const current = conversations[currentConversationId] ?? emptyConversation()
      conversations[currentConversationId] = { ...current, activeTabId: QUESTIONS_SURFACE_ID }
      visible = true
    }

    set({
      ...project({ ...state, conversations, currentConversationId, visible }),
      currentConversationId,
    })
    rDebug('studio.surface', 'conversation selected', {
      tab_id: currentConversationId ?? '',
      active_surface_tab: currentConversationId ? (conversations[currentConversationId]?.activeTabId ?? '') : '',
      visible,
      mode: shouldRememberVisibility() ? 'per-conversation' : 'keep',
      forced_questions: owesAnswer,
    })

}
