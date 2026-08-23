import React, { useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { useColors } from "../../theme";
import { groupMessages } from "./tool-helpers";
import { TranscriptRows } from "./TranscriptRows";
import { useScrollFollow } from "./useScrollFollow";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { AgentPanel } from "../AgentPanel";
import { DispatchStopControl } from "../DispatchStopControl";
import { useSessionStore } from "../../stores/sessionStore";
import type { Message } from "../../../shared/types-session";
import type { AgentStateUpdate } from "../../../shared/types-engine";
import type { DispatchTelemetryEntry } from "../../../shared/types-engine";

// Stable empty refs to avoid new references each render (same pattern
// as ConversationView.tsx).
const EMPTY_AGENTS: AgentStateUpdate[] = [];
const EMPTY_TELEMETRY: DispatchTelemetryEntry[] = [];

// Reserved bottom padding when the activity overlay is visible, matching
// ConversationView.tsx's own CONVERSATION_ACTIVITY_OVERLAY_HEIGHT — the two
// overlays are visually identical, so their reserved space matches too.
const ACTIVITY_OVERLAY_HEIGHT = 56;

export interface TranscriptProps {
  messages: Message[];
  unifiedTurnView: boolean;
  pinnedPrompt?: string;
  isRunning: boolean;
  /** Per-message action renderer (rewind/fork menu on user bubbles). */
  actions?: (msg: Message) => React.ReactNode;
  /** Live agent state updates for the embedded AgentPanel. */
  agents?: AgentStateUpdate[];
  /** Flat dispatch telemetry for agent nesting depth. */
  dispatchTelemetry?: DispatchTelemetryEntry[];
  /** Called when the user opens a dispatch detail popup from the agent panel. */
  onOpenDispatch?: (
    dispatch: import("../../../shared/types-engine").DispatchInfo,
    agent: AgentStateUpdate,
  ) => void;
  /**
   * True when this transcript renders a sub-dispatch tier (inside the
   * dispatch-preview popup). Forwarded to the embedded AgentPanel so it bypasses
   * the top-level-only visibility filter and always shows the dispatched agents.
   */
  subDispatch?: boolean;
  /** Owning tab, forwarded so nested AgentRows can stop their dispatches. */
  tabId?: string;
  /**
   * The dispatch this transcript IS — the subject whose own conversation is
   * being read. Present only for a dispatch-preview tier (subDispatch=true);
   * absent for the root conversation, which has no dispatchId. When set, and
   * the subject is running, an activity/Stop overlay renders pinned to the
   * bottom of THIS transcript's own scroll region — the same visual pattern
   * ConversationView uses for the orchestrator's own run, so a Stop control
   * always reads as "stopping the conversation you're looking at," never as
   * part of the agent panel beneath it.
   */
  activityDispatchId?: string;
  /** Every running dispatch instance in the row that owns activityDispatchId,
   * for Stop-all. Required alongside activityDispatchId to show the overlay. */
  activityRunningDispatchIds?: string[];
  /** Current activity text for the overlay (e.g. agent's lastWork). */
  activityText?: string;
}

/**
 * Unified, shared transcript renderer. Groups messages and renders every
 * kind (user, assistant, tool-group, agent-turn, thinking, harness,
 * intercept, system, compaction). Includes scroll-follow behavior, the
 * scroll-to-bottom FAB, an optional pinned-prompt bar, an optional
 * activity/Stop overlay pinned to THIS transcript's own scroll region (when
 * this transcript is itself a running dispatch), and the embedded AgentPanel.
 */
export function Transcript({
  messages,
  unifiedTurnView,
  pinnedPrompt,
  isRunning,
  actions,
  agents,
  dispatchTelemetry,
  onOpenDispatch,
  subDispatch,
  tabId,
  activityDispatchId,
  activityRunningDispatchIds,
  activityText,
}: TranscriptProps) {
  const colors = useColors();
  const abortDispatch = useSessionStore((s) => s.abortDispatch);
  const abortDispatches = useSessionStore((s) => s.abortDispatches);
  const grouped = useMemo(
    () => groupMessages(messages, { includeUser: true, unifiedTurnView }),
    [messages, unifiedTurnView],
  );

  const agentList = agents ?? EMPTY_AGENTS;
  const telemetry = dispatchTelemetry ?? EMPTY_TELEMETRY;

  const { scrollRef, showScrollBtn, handleScroll, scrollToBottom } =
    useScrollFollow([messages.length, agentList.length, isRunning]);

  // activityDispatchId is only ever supplied by the caller when that exact
  // dispatch is confirmed running (AgentDetailBody gates it against its own
  // per-dispatch runningRowDispatchIds before passing it down) — its mere
  // presence, plus a tabId to address it in, is the full "show the overlay"
  // condition. Re-checking the agent-level `isRunning` here would be a
  // second, looser signal that can disagree with the dispatch-level one (an
  // agent can read "done" while a specific dispatch instance is still live),
  // so it is deliberately not part of this gate.
  const activityOverlayVisible = !!tabId && !!activityDispatchId;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        position: "relative",
      }}
    >
      {/* Pinned prompt bar */}
      {pinnedPrompt && (
        <div
          style={{
            padding: "8px 12px",
            borderBottom: `1px solid ${colors.containerBorder}`,
            fontSize: 13,
            color: colors.textSecondary,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          <span style={{ color: colors.accent, fontWeight: 600 }}>{" > "}</span>
          {pinnedPrompt}
        </div>
      )}

      {/* Scrollable body */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          style={{
            height: "100%",
            overflowY: "auto",
            padding: `8px 12px ${activityOverlayVisible ? ACTIVITY_OVERLAY_HEIGHT + 8 : 8}px`,
          }}
        >
          <TranscriptRows grouped={grouped} actions={actions} />
        </div>
        <ScrollToBottomButton
          visible={showScrollBtn}
          onClick={scrollToBottom}
        />

        {/* Activity/Stop overlay for THIS transcript's own subject, pinned to
            the bottom of its own scroll region — the identical visual pattern
            ConversationView uses for the orchestrator's own run. Anchoring it
            here (inside the transcript that is scrolling) rather than as a
            flow-footer after the embedded AgentPanel is what keeps a dispatch
            preview's Stop reading as "stop the conversation on screen," not
            as a control belonging to the agent panel beneath it. */}
        <AnimatePresence>
          {activityOverlayVisible && (
            <motion.div
              data-testid="dispatch-activity-row"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                zIndex: 2,
                minHeight: 40,
                pointerEvents: "none",
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  position: "absolute",
                  inset: 0,
                  background: `linear-gradient(to bottom, transparent, ${colors.containerBg} 55%)`,
                  backdropFilter: "blur(5px)",
                  WebkitBackdropFilter: "blur(5px)",
                }}
              />
              <div
                style={{
                  position: "relative",
                  padding: "12px 12px 4px",
                  display: "flex",
                  alignItems: "flex-end",
                  justifyContent: "space-between",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    color: colors.textTertiary,
                    minWidth: 0,
                  }}
                >
                  <span
                    className="animate-pulse-dot"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: colors.statusRunning,
                      display: "inline-block",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    data-testid="dispatch-activity-indicator"
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {activityText}
                  </span>
                </div>
                <div
                  data-testid="dispatch-interrupt-row"
                  style={{ pointerEvents: "auto" }}
                >
                  <DispatchStopControl
                    dispatchId={activityDispatchId!}
                    runningDispatchIds={activityRunningDispatchIds ?? []}
                    onStop={(dispatchId) => abortDispatch(tabId!, dispatchId)}
                    onStopAll={(dispatchIds) =>
                      abortDispatches(tabId!, dispatchIds)
                    }
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Embedded agent panel. Always rendered inside the dispatch preview so
          the panel is present even before the lead dispatches a specialist
          (shows "Agents (0)"), then populates as children spawn. */}
      <AgentPanel
        agents={agentList}
        dispatchTelemetry={telemetry}
        onOpenDispatch={onOpenDispatch}
        subDispatch={subDispatch}
        tabId={tabId}
        alwaysRender
      />
    </div>
  );
}

