import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  CaretRight,
  ArrowsOutSimple,
  ArrowsInSimple,
} from "@phosphor-icons/react";
import { useColors } from "../theme";
import type { AgentStateUpdate, Message } from "../../shared/types";
import type {
  DispatchInfo,
  DispatchTelemetryEntry,
} from "../../shared/types-engine";
import { AgentRow } from "./AgentRow";
import { AgentDetailPanel } from "./AgentDetailPanel";
import {
  dispatchKey,
  getDispatches,
  mostRecentDispatch,
} from "./agent-panel-helpers";
import { DEFAULT_PANEL_HEIGHT } from "./agent-panel-resize";

interface PopupData {
  dispatches: DispatchInfo[];
  dispIdx: number;
  slicedMsgs: Message[] | undefined;
  isLoading: boolean;
}

interface Props {
  colors: ReturnType<typeof useColors>;
  panelRef: React.RefObject<HTMLDivElement | null>;
  agents: AgentStateUpdate[];
  visible: AgentStateUpdate[];
  dispatchTelemetry?: DispatchTelemetryEntry[];
  agentDepths: Map<string, number>;
  selectedDispatch: Map<string, number>;
  defaultDispatchIndex: (dispatches: DispatchInfo[]) => number;
  panelCollapsed: boolean;
  onTogglePanel: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  panelHeight?: number;
  onPanelHeightChange?: (height: number) => void;
  handleDragStart: (event: React.MouseEvent<HTMLDivElement>) => void;
  headerCounts: {
    total: number;
    dispatches: number;
    active: number;
    done: number;
  };
  subDispatch?: boolean;
  tabId?: string;
  onToggleAgent: (agent: AgentStateUpdate) => void;
  popupAgent: AgentStateUpdate | null;
  popupData: PopupData | null;
  onSelectDispatch: (index: number) => void;
  onClosePopup: () => void;
}

export function AgentPanelView({
  colors,
  panelRef,
  agents,
  visible,
  dispatchTelemetry,
  agentDepths,
  selectedDispatch,
  defaultDispatchIndex,
  panelCollapsed,
  onTogglePanel,
  isFullscreen,
  onToggleFullscreen,
  panelHeight,
  onPanelHeightChange,
  handleDragStart,
  headerCounts,
  subDispatch,
  tabId,
  onToggleAgent,
  popupAgent,
  popupData,
  onSelectDispatch,
  onClosePopup,
}: Props) {
  const effectiveHeight = panelHeight ?? DEFAULT_PANEL_HEIGHT;

  return (
    <div
      ref={panelRef}
      data-ion-ui
      style={{
        borderTop: `1px solid ${colors.containerBorder}`,
        flexShrink: 0,
      }}
    >
      {onPanelHeightChange && !panelCollapsed && !isFullscreen && (
        <div
          onMouseDown={handleDragStart}
          style={{
            height: 4,
            cursor: "ns-resize",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: 32,
              height: 2,
              borderRadius: 1,
              background: colors.textTertiary,
              opacity: 0.3,
              transition: "opacity 0.15s",
            }}
          />
        </div>
      )}

      <div
        data-ion-ui
        onClick={onTogglePanel}
        style={{
          display: "flex",
          alignItems: "center",
          height: 20,
          padding: "0 8px",
          cursor: "pointer",
          userSelect: "none",
          fontSize: 10,
          color: colors.textTertiary,
          gap: 4,
        }}
      >
        <CaretRight
          size={8}
          style={{
            transform: panelCollapsed ? "rotate(0deg)" : "rotate(90deg)",
            transition: "transform 0.15s ease",
          }}
        />
        <span>
          {subDispatch ? "Child agents" : "Agents"} · {headerCounts.total}
        </span>
        <span>
          · {headerCounts.dispatches}{" "}
          {headerCounts.dispatches === 1 ? "dispatch" : "dispatches"}
        </span>
        {headerCounts.active > 0 && (
          <span style={{ color: colors.statusRunning, fontWeight: 600 }}>
            · {headerCounts.active} active
          </span>
        )}
        {headerCounts.done > 0 && (
          <span style={{ color: colors.statusComplete, fontWeight: 600 }}>
            · {headerCounts.done} done
          </span>
        )}
        {onToggleFullscreen && (
          <button
            onClick={(event) => {
              event.stopPropagation();
              onToggleFullscreen();
            }}
            style={{
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              color: colors.textTertiary,
              display: "flex",
              alignItems: "center",
              marginLeft: "auto",
            }}
            title={isFullscreen ? "Collapse agent panel" : "Expand agent panel"}
          >
            {isFullscreen ? (
              <ArrowsInSimple size={10} />
            ) : (
              <ArrowsOutSimple size={10} />
            )}
          </button>
        )}
      </div>

      <AnimatePresence>
        {!panelCollapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            style={{
              overflow: "hidden",
              maxHeight: isFullscreen ? undefined : effectiveHeight,
              overflowY: "auto",
            }}
          >
            {visible.map((agent) => {
              const key = dispatchKey(agent);
              const rowDispatches = getDispatches(agent);
              const rowDispIdx =
                selectedDispatch.get(key) ??
                defaultDispatchIndex(rowDispatches);
              const nestDepth =
                agentDepths.get(mostRecentDispatch(rowDispatches)?.id ?? "") ??
                0;
              const nestIndent = nestDepth > 1 ? (nestDepth - 1) * 16 : 0;

              return (
                <AgentRow
                  key={key}
                  agent={agent}
                  allAgents={agents}
                  colors={colors}
                  nestIndent={nestIndent}
                  dispatches={rowDispatches}
                  dispIdx={rowDispIdx}
                  tabId={tabId}
                  onToggle={() => onToggleAgent(agent)}
                />
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>

      {popupAgent && popupData && (
        <AgentDetailPanel
          agent={popupAgent}
          loadedMessages={popupData.slicedMsgs}
          loading={popupData.isLoading}
          dispatches={popupData.dispatches}
          selectedDispatch={popupData.dispIdx}
          onSelectDispatch={onSelectDispatch}
          onClose={onClosePopup}
          dispatchTelemetry={dispatchTelemetry}
          allAgents={agents}
          tabId={tabId}
        />
      )}
    </div>
  );
}
