/**
 * session-store-facade — plain-function wrappers around `useSessionStore` for
 * callers that must not import the raw Zustand hook directly (the desktop's
 * `main/` process, per desktop/AGENTS.md § Studio shell rules, "No session logic in
 * `desktop/src/main`": `grep -rn "sessionStore" desktop/src/main` must stay
 * at 0). These are pass-throughs — no new behavior, just a named seam so the
 * store's internal hook name stays an implementation detail.
 */
import { useSessionStore } from './sessionStore';
import { setTabStatus, type TabStatusSource } from './slices/tab-status-transition';
import type { Message } from '@ion/shared/types-session';

/** Append a system-message bubble to a tab's active conversation instance. */
export function addEngineSystemMessage(
  tabId: string,
  content: string,
  planFilePath?: string,
): void {
  useSessionStore.getState().addEngineSystemMessage(tabId, content, planFilePath);
}

/** Reset a tab's status from 'connecting' back to 'idle' (no-op if it already moved past connecting, e.g. to 'running'). */
export function clearConnectingTabStatus(tabId: string, reason: TabStatusSource): void {
  useSessionStore.setState((s) => ({
    tabs: setTabStatus(s.tabs, tabId, 'idle', reason, (t) => t.status === 'connecting'),
  }));
}

/** The active conversation instance's messages for a tab, deep-cloned (safe for IPC). Empty array when the tab or instance is unknown. */
export function getActiveInstanceMessages(tabId: string): Message[] {
  const s = useSessionStore.getState();
  const tab = s.tabs.find((t) => t.id === tabId);
  if (!tab) return [];
  const pane = s.conversationPanes.get(tab.id);
  const inst = pane
    ? (pane.instances.find((i) => i.id === pane.activeInstanceId) ?? pane.instances[0])
    : null;
  return inst ? structuredClone(inst.messages ?? []) : [];
}
