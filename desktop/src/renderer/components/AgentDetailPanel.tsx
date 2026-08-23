import React, { useCallback } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { FloatingPanel } from "./FloatingPanel";
import { AgentDetailBody } from "./AgentDetailBody";
import { meta } from "./agent-panel-helpers";
import type { DispatchInfo, BreadcrumbFrame } from "./agent-panel-helpers";
import type { AgentStateUpdate } from "../../shared/types";
import type { Message } from "../../shared/types";
import type { DispatchTelemetryEntry } from "../../shared/types-engine";

// BreadcrumbFrame now lives with the pure helpers in renderer/lib/agent-helpers
// (buildBreadcrumbStack constructs it). Re-exported here so existing imports
// of the type from this component keep working.
export type { BreadcrumbFrame };

interface AgentDetailPanelProps {
  agent: AgentStateUpdate;
  loadedMessages: Message[] | undefined;
  loading: boolean;
  dispatches: DispatchInfo[];
  selectedDispatch: number;
  onSelectDispatch: (idx: number) => void;
  onClose: () => void;
  /** Flat dispatch telemetry for deriving child dispatches (live stream). */
  dispatchTelemetry?: DispatchTelemetryEntry[];
  /**
   * The full agent-state list for the active instance. The DURABLE source for
   * nested children: agent-state pills carry dispatchParentId/dispatches[] and
   * survive `engine_agent_state` heartbeat replay, so the preview renders
   * children correctly even when the one-shot dispatchTelemetry was missed
   * (late attach / tab reopen). See childAgentsOf in agent-panel-helpers.
   */
  allAgents?: AgentStateUpdate[];
  /**
   * Pre-populated breadcrumb stack for deep-link entry. When provided, the
   * panel initializes with this stack instead of the root-only single-frame
   * default. Built by `buildBreadcrumbStack` in agent-panel-helpers, which
   * walks dispatchParentId up through durable agentStates.
   *
   * Enables n-tier deep-links from the StatusDrawer without requiring the
   * user to drill down through each intermediate tier manually.
   */
  initialStack?: BreadcrumbFrame[];
  /**
   * Owning tab, forwarded to transcript and dispatch Stop controls. Threaded
   * rather than read from the store because this panel is also mounted for
   * sub-dispatch previews, which must address the same session.
   */
  tabId?: string;
}

/**
 * AgentDetailPanel — the overlay's floating popup chrome around the shared
 * dispatch body.
 *
 * This component owns ONLY the FloatingPanel frame (title, close, draggable
 * geometry). All breadcrumb/pager/meta-bar/transcript/Stop-control behavior
 * lives in AgentDetailBody, which the Studio center's DispatchSplitPane also
 * renders directly. The two used to be independent copies that had drifted —
 * a Stop control existed in one and not the other. Delegating here instead
 * of re-implementing keeps that from happening again: there is exactly one
 * place the dispatch body's behavior can be defined.
 */
export function AgentDetailPanel({
  agent,
  loadedMessages,
  loading,
  dispatches,
  selectedDispatch,
  onSelectDispatch,
  onClose,
  dispatchTelemetry,
  allAgents,
  initialStack,
  tabId,
}: AgentDetailPanelProps) {
  const geometry = useSessionStore((s) => s.agentDetailGeometry);
  const setGeometry = useSessionStore((s) => s.setAgentDetailGeometry);
  const handleGeometryChange = useCallback(
    (geo: { x: number; y: number; w: number; h: number }) => setGeometry(geo),
    [setGeometry],
  );

  const title = meta(agent, "displayName", agent.name);

  return (
    <FloatingPanel
      title={title}
      onClose={onClose}
      defaultWidth={600}
      defaultHeight={500}
      initialPos={{ x: geometry.x, y: geometry.y }}
      initialSize={{ w: geometry.w, h: geometry.h }}
      onGeometryChange={handleGeometryChange}
    >
      <AgentDetailBody
        agent={agent}
        loadedMessages={loadedMessages}
        loading={loading}
        dispatches={dispatches}
        selectedDispatch={selectedDispatch}
        onSelectDispatch={onSelectDispatch}
        dispatchTelemetry={dispatchTelemetry}
        allAgents={allAgents}
        initialStack={initialStack}
        tabId={tabId}
      />
    </FloatingPanel>
  );
}
