/**
 * What a click on a Visualizer entity does, extracted from VisualizerRoot
 * (file cap). Pure over the engine and the active state; the surface host's
 * `onAgentClick` routes the selection when one is mounted, and selecting the
 * conversation's tab is the whole action when none is.
 */
import { rInfo } from "../../rendererLogger";
import { useSessionStore } from "@ion/server/store/sessionStore";
import type { StudioEngine } from "./engine";
import type { StudioActiveState } from "./state/agent-cache";

export function handleEntityClick(
  engine: StudioEngine,
  active: StudioActiveState,
  point: { x: number; y: number },
  shiftKey: boolean,
  onAgentClick: ((tabId: string, agentName: string) => void) | undefined,
): void {
  const entity = engine.getEntityAt(point.x, point.y);
  if (!entity || entity.role === "pet") return;
  // The manager = the orchestrator = the main conversation: clicking him
  // shows that conversation (no dispatch panel).
  if (entity.name === "__manager__") {
    rInfo("studio", "manager clicked", { tab_id: active.tabId });
    if (onAgentClick) onAgentClick(active.tabId, "__manager__");
    else useSessionStore.getState().selectTab(active.tabId);
    return;
  }
  // Shift+click: follow-cam / focus-mode cycle (game-feel camera).
  if (shiftKey) {
    const mode = engine.cycleFollow(entity.name);
    rInfo("studio", "follow cycled", { agent: entity.name, mode });
    return;
  }
  if (!entity.working && !entity.completed && !entity.waiting) return;
  rInfo("studio", "agent clicked", {
    agent: entity.name,
    tab_id: active.tabId,
  });
  if (onAgentClick) onAgentClick(active.tabId, entity.name);
  else useSessionStore.getState().selectTab(active.tabId);
}
