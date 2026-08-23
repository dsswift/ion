/**
 * active-tab-notifier — single funnel for telling the main process which tab
 * is active.
 *
 * Previously only selectTab() fired notifyTabFocus, so tab-create paths
 * (createTab / createTabInDirectory set activeTabId directly) changed the
 * active tab without notifying — extensions listening to the desktop.focus
 * resource and the Ion Studio both missed those transitions.
 * Subscribing to the store closes that gap for every current and future
 * mutation of activeTabId.
 *
 * Visiting a tab routes review acknowledgement through the owner store action.
 * The focus publication stays deduplicated by active tab, while an explicit
 * click on the already-active row is handled by selectTab itself.
 */
import { useSessionStore } from '../stores/sessionStore'

let lastSent: string | null = null
let unsubscribe: (() => void) | null = null

function send(state: { activeTabId: string | null; tabs: Array<{ id: string; engineProfileId?: string | null }> }): void {
  const tabId = state.activeTabId
  if (!tabId || tabId === lastSent) return

  lastSent = tabId
  // Visiting after a completion is the explicit review boundary. Route it
  // through the owner action so Studio's mirror never writes durable tab state.
  useSessionStore.getState().markTabRead(tabId)

  // engineProfileId rides along so the Ion Studio can scope its
  // office seed per extension (per the tab-extension seed contract).
  const engineProfileId = state.tabs.find((t) => t.id === tabId)?.engineProfileId ?? null
  window.ion.notifyTabFocus(tabId, engineProfileId)
}

/** Start the notifier (idempotent). Called once from App mount. */
export function initActiveTabNotifier(): () => void {
  if (unsubscribe) return unsubscribe
  send(useSessionStore.getState())
  const off = useSessionStore.subscribe((state) => {
    send(state)
  })
  unsubscribe = () => {
    off()
    unsubscribe = null
    lastSent = null
  }
  return unsubscribe
}
