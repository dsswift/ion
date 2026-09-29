/**
 * StudioCenter — the Studio shell's center column: the conversation is the
 * main surface (ConversationView + composer pill), with the collapsible
 * bottom terminal multiplexer under it. The dispatch split pane joins in
 * its own workstream and renders beside the conversation in this row.
 *
 * Carries the mirror-side skeleton-hydration effect from the deleted
 * StudioSideDock: mirror panes start as skeletons (persisted messageCount,
 * empty messages) because the owner's selectTab lazy-load never runs here —
 * loadSkeletonMessages is the mirror-local hydration path.
 */
import React, { useEffect } from "react";
import { useSessionStore } from "@ion/server/store/sessionStore";
import {
  activeInstance,
  needsHistoryHydration,
} from "@ion/server/store/conversation-instance";
import { ConversationView } from "../components/ConversationView";
import { ConversationErrorBoundary } from "../components/conversation";
import { InputBar } from "../components/InputBar";
import { TerminalPanel } from "../components/TerminalPanel";
import { TerminalBigScreen } from "../components/TerminalBigScreen";
import { DispatchSplitPane } from "./DispatchSplitPane";
import { activeDispatchSplit } from "./dispatch-split-state";
import { useResizablePane } from "../hooks/useResizablePane";
import { useColors } from "../theme";
import { rDebug } from "../rendererLogger";
import { useComposerDragStore } from "../components/composer/composer-drag-store";
import {
  STUDIO_LAYOUT_BOUNDS,
  type StudioLayout,
} from "@ion/shared/types-studio";

export interface StudioCenterProps {
  layout: StudioLayout;
  /** Live terminal height during a drag. */
  liveTerminalHeight: number;
  onLiveTerminalResize: (h: number) => void;
  onCommitTerminalHeight: (h: number) => void;
  onFocusCapture?: () => void;
  onMouseDownCapture?: () => void;
}

export function StudioCenter(props: StudioCenterProps): React.JSX.Element {
  const colors = useColors();
  const composerDragging = useComposerDragStore((s) => s.dragging);
  const activeTabId = useSessionStore((s) => s.activeTabId);
  const activeTab = useSessionStore((s) =>
    s.tabs.find((tab) => tab.id === s.activeTabId),
  );
  const workingDirectory = activeTab?.workingDirectory ?? "~";
  const isTerminalOnly = activeTab?.isTerminalOnly ?? false;
  const dispatchSplitOpen = useSessionStore((s) =>
    activeDispatchSplit(s.dispatchSplit, s.activeTabId) !== null,
  );
  const isTerminalTall = useSessionStore(
    (s) => s.terminalTallTabId === s.activeTabId,
  );
  const isTerminalBigScreen = useSessionStore(
    (s) => s.terminalBigScreenTabId === s.activeTabId,
  );
  const terminalVisible = useSessionStore((s) =>
    s.terminalOpenTabIds.has(s.activeTabId),
  );

  // needsHistoryHydration, not message emptiness: live events stream into
  // mirror skeleton panes before the user switches to them, and an emptiness
  // check would skip the history load — showing only the last live turn.
  const needsHydration = useSessionStore((s) =>
    needsHistoryHydration(activeInstance(s.conversationPanes, s.activeTabId)),
  );
  useEffect(() => {
    if (!activeTabId || !needsHydration) return;
    rDebug("studio.center", "hydrating skeleton conversation", {
      tab_id: activeTabId.slice(0, 8),
    });
    void useSessionStore.getState().loadSkeletonMessages(activeTabId);
  }, [activeTabId, needsHydration]);

  const bounds = STUDIO_LAYOUT_BOUNDS.terminalHeight;
  const { handleProps, dragging } = useResizablePane({
    axis: "y",
    edge: "start", // handle on the terminal's top edge; dragging up grows it
    min: bounds.min,
    max: bounds.max,
    size: props.liveTerminalHeight,
    onResize: props.onLiveTerminalResize,
    onCommit: props.onCommitTerminalHeight,
  });

  return (
    <div
      onFocusCapture={props.onFocusCapture}
      onMouseDownCapture={props.onMouseDownCapture}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {!activeTabId ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: colors.textTertiary,
            fontSize: 13,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          No active conversation.
        </div>
      ) : (
        <>
          {!isTerminalOnly && !isTerminalTall && (
            <>
              <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
                <div
                  style={{
                    flex: dispatchSplitOpen
                      ? 1 - props.layout.dispatchSplitRatio
                      : 1,
                    minWidth: 0,
                    minHeight: 0,
                    overflowY: "auto",
                  }}
                >
                  <ConversationErrorBoundary>
                    <ConversationView key={activeTabId} tabId={activeTabId} />
                  </ConversationErrorBoundary>
                </div>
                {dispatchSplitOpen && (
                  <div
                    style={{
                      flex: props.layout.dispatchSplitRatio,
                      minWidth: 0,
                      minHeight: 0,
                      display: "flex",
                    }}
                  >
                    <DispatchSplitPane />
                  </div>
                )}
              </div>
              <div style={{ flexShrink: 0, padding: "10px 12px 12px", position: "relative" }}>
                <div
                  className="ion-input-shell"
                  style={{
                    minHeight: 50,
                    borderRadius: 22,
                    padding: "0 8px 0 14px",
                    background: colors.inputPillBg,
                    // A static color swap marks the drop target; no animation.
                    border: `1px solid ${composerDragging ? colors.accent : colors.containerBorder}`,
                  }}
                >
                  <InputBar />
                </div>
              </div>
            </>
          )}
          {(terminalVisible || isTerminalOnly) && !isTerminalBigScreen && (
            <div
              style={{
                flex: isTerminalTall || isTerminalOnly ? 1 : undefined,
                flexShrink: isTerminalTall || isTerminalOnly ? undefined : 0,
                height: isTerminalTall || isTerminalOnly ? undefined : props.liveTerminalHeight,
                borderTop: `1px solid ${colors.containerBorder}`,
                position: "relative",
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
              }}
            >
              {/* Top-edge resize handle (hidden when tall fills the column). */}
              {!isTerminalTall && !isTerminalOnly && (
                <div
                  {...handleProps}
                  style={{
                    ...handleProps.style,
                    position: "absolute",
                    top: -3,
                    left: 0,
                    right: 0,
                    height: 6,
                    zIndex: 2,
                    background: dragging ? colors.accent : "transparent",
                    opacity: dragging ? 0.4 : 1,
                  }}
                />
              )}
              <TerminalPanel
                tabId={activeTabId}
                cwd={workingDirectory}
                autoCreate
              />
            </div>
          )}
        </>
      )}
      {isTerminalBigScreen && activeTabId && (
        <TerminalBigScreen tabId={activeTabId} />
      )}
    </div>
  );
}
