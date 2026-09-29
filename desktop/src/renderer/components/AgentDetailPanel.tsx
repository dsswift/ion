import React, { useCallback } from "react";
import { useSessionStore } from "@ion/server/store/sessionStore";
import { FloatingPanel } from "./FloatingPanel";
import { AgentDetailBody } from "./AgentDetailBody";
import { meta } from "./agent-panel-helpers";
import type { DispatchInfo } from "./agent-panel-helpers";
import type { AgentStateUpdate } from "@ion/shared/types";
import type { Message } from "@ion/shared/types";
import type { DispatchTelemetryEntry } from "@ion/shared/types-engine";

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
        tabId={tabId}
      />
    </FloatingPanel>
  );
}
