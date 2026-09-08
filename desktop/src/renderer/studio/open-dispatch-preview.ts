/**
 * Open (or re-target) the dispatch preview for an agent of the active
 * conversation. A dispatch preview is one conversation-local surface tab:
 * reopening it updates that tab's subject instead of creating another
 * runtime panel. Lives beside StudioShell, which routes agent clicks here.
 */
import { useSessionStore } from "../stores/sessionStore";
import { rDebug } from "../rendererLogger";
import { contentRouter } from "../lib/file-open-router";
import { getDispatches, meta, mostRecentDispatch } from "../components/agent-panel-helpers";

export function openDispatchPreview(agentName: string): void {
  if (agentName === "__manager__") return;
  const state = useSessionStore.getState();
  const pane = state.conversationPanes.get(state.activeTabId);
  const instance = pane?.instances.find((item) => item.id === pane.activeInstanceId);
  const agent = instance?.agentStates.find((item) => item.name === agentName);
  if (!agent) {
    rDebug("studio.surface", "dispatch preview agent was not found", {
      agent: agentName,
      tab_id: state.activeTabId,
    });
    return;
  }
  const dispatch = mostRecentDispatch(getDispatches(agent));
  if (!dispatch?.id) {
    rDebug("studio.surface", "dispatch preview agent has no dispatch", {
      agent: agentName,
      tab_id: state.activeTabId,
    });
    return;
  }
  const title = meta(agent, "displayName", agent.name);
  contentRouter()?.openDispatch?.(agent.name, dispatch.id, title);
}
