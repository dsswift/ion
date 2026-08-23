import React, { useState, useEffect, useRef, useCallback } from "react";
import { useColors } from "../theme";
import { usePreferencesStore } from "../preferences";
import { useSessionStore } from "../stores/sessionStore";
import {
  meta,
  isAgentVisible,
  isRootLevelAgent,
  sortAgents,
  getDispatches,
  selectAgentDepths,
  dispatchKey,
  isAgentActive,
} from "./agent-panel-helpers";
import { reconcileActivity } from "./agent-dispatch-activity";
import { mapConversationMessages } from "./agent-conversation-mapper";
import { AgentPanelView } from "./AgentPanelView";
import { useAgentDetailOpener } from "../hooks/useAgentDetailOpener";
import { useAgentPanelResize } from "./agent-panel-resize";
import type { AgentStateUpdate } from "../../shared/types";
import type { Message } from "../../shared/types";
import type {
  DispatchInfo,
  DispatchTelemetryEntry,
} from "../../shared/types-engine";
import { rDebug, rError } from "../rendererLogger";
import { mostRecentDispatchIndex, routeAgentDetailToSurface } from "./agent-detail-routing";

interface Props {
  agents: AgentStateUpdate[];
  /** Flat dispatch telemetry entries for deriving nesting depth. */
  dispatchTelemetry?: DispatchTelemetryEntry[];
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** Custom panel height in pixels (rows container). Undefined = default. */
  panelHeight?: number;
  /** Called when the user drags the resize handle to a new height. */
  onPanelHeightChange?: (height: number) => void;
  /**
   * Main-conversation scope: show only the orchestrator's ROOT dispatches
   * (agents whose dispatch telemetry has no parent). Sub-dispatched (depth-2+)
   * agents are excluded so they never surface in the main panel. The embedded
   * popup panel leaves this false — its agent set is already child-scoped.
   */
  rootOnly?: boolean;
  /**
   * Sub-dispatch scope: this panel renders a tier BELOW the orchestrator
   * (inside the dispatch-preview popup). Visibility is a top-level-only concept
   * (`isAgentVisible`); sub-dispatched agents always show regardless of their
   * `visibility` metadata, so the visibility filter is bypassed here. The main
   * conversation panel leaves this false to preserve always/sticky/ephemeral.
   */
  subDispatch?: boolean;
  /**
   * When provided, clicking an agent row escalates to this callback instead of
   * opening AgentPanel's own internal detail popup. The dispatch-preview popup
   * passes this so a click drills one tier down and pushes onto its breadcrumb
   * stack, rather than spawning a second floating panel.
   */
  onOpenDispatch?: (dispatch: DispatchInfo, agent: AgentStateUpdate) => void;
  /**
   * Render the panel chrome (the "Agents (N)" header) even when there are zero
   * agents. The dispatch-preview popup sets this so the embedded panel is always
   * present in the preview; the main conversation panel leaves it false so a
   * conversation with no agents shows no empty panel.
   */
  alwaysRender?: boolean;
  /**
   * Owning tab. Forwarded to the detail panel so a running dispatch can be
   * stopped from its preview. Optional so embedded/sub-dispatch panels that
   * have no tab context simply omit the control.
   */
  tabId?: string;
}

export function AgentPanel({
  agents,
  dispatchTelemetry,
  isFullscreen,
  onToggleFullscreen,
  panelHeight,
  onPanelHeightChange,
  rootOnly,
  subDispatch,
  onOpenDispatch,
  alwaysRender,
  tabId,
}: Props) {
  const colors = useColors();
  const agentPanelDefaultOpen = usePreferencesStore(
    (s) => s.agentPanelDefaultOpen,
  );
  // Live push transcript, keyed by child conversationId. Folded from
  // dispatch_activity deltas in the engine-event slice; reconciled with the
  // file-backed snapshot below.
  const dispatchActivity = useSessionStore((s) => s.dispatchActivity);
  const [panelCollapsed, setPanelCollapsed] = useState(true);
  // Keyed by conversationId — each dispatch's conversation is loaded independently
  const [convMessages, setConvMessages] = useState<Map<string, Message[]>>(
    new Map(),
  );
  const [convLoading, setConvLoading] = useState<Map<string, boolean>>(
    new Map(),
  );
  // Track which dispatch index is selected, keyed by DISPATCH ID (see above).
  const [selectedDispatch, setSelectedDispatch] = useState<Map<string, number>>(
    new Map(),
  );
  // Popup subject stays tied to the exact dispatch the operator opened. Agent
  // snapshots can reorder history or add a newer dispatch; deriving the popup
  // from dispatchKey(agent) would silently repoint an open panel.
  const [popupSubject, setPopupSubject] = useState<{
    agentName: string;
    dispatchId: string;
  } | null>(null);
  const prevVisibleCount = useRef(0);
  // Tracks whether the user manually toggled the panel this "session"
  // (since agents last appeared). Reset when agents go from 0→N so the
  // default-open preference drives the initial state on each fresh batch.
  const userToggled = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Detail defaults must identify the same dispatch as AgentRow's foreground
  // dot and duration. Dispatch arrays retain slot-insertion order, not
  // chronology, so array-last is only a fallback when start times are absent.
  const defaultDispatchIndex = useCallback(mostRecentDispatchIndex, []);

  // Visibility + root scoping. Memoized so `visible` is a stable reference:
  // `filter` and `sortAgents` always produce new arrays, and effects that
  // depend on `visible` would re-fire on every render (once per streaming text
  // chunk) without memoization — causing sustained re-render thrashing.
  //  - subDispatch tiers: skip the always/sticky/ephemeral visibility filter.
  //  - rootOnly (main conversation): drop depth-2+ nested dispatches. Each
  //    agent carries dispatchDepth / dispatchParentId from dispatch_agent.go,
  //    so the filter is per-instance — the same agent name dispatched at both
  //    root and nested levels is handled correctly. Agents with no attribution
  //    (extension-roster rows, pre-fix state) are treated as root-level.
  const visible = React.useMemo(() => {
    const visibilityFiltered = subDispatch
      ? agents
      : agents.filter(isAgentVisible);
    const scoped = rootOnly
      ? visibilityFiltered.filter(isRootLevelAgent)
      : visibilityFiltered;
    return sortAgents(scoped);
  }, [agents, subDispatch, rootOnly]);

  // Derive per-agent nesting depth from flat dispatch telemetry.
  const agentDepths = React.useMemo(
    () => selectAgentDepths(dispatchTelemetry || []),
    [dispatchTelemetry],
  );

  // Header breakdown — total / active / done, derived over the SAME filtered
  // `visible` set the list renders (not the raw `agents` array) so the header
  // stays honest against the rows below it. Ephemeral agents drop out of
  // `visible` when they finish, so `done` counts only the always/sticky agents
  // that completed and remain clickable in the list. `error` folds into neither
  // active nor done — it is surfaced by its own red row dot.
  //
  // ACTIVE is `isAgentActive`, not the row's own status: an agent counts as
  // active when it is running/suspended OR when any of its dispatches still
  // owns a live descendant. Reading the bare status is how a live tree once
  // showed "3 done" with no active segment while a specialist under a finished
  // dispatch was still working — the same defect the row's background dot
  // fixes, so the two must agree. `done` therefore also excludes rows that are
  // terminal but still waiting on a descendant.
  const headerCounts = React.useMemo(() => {
    let active = 0;
    let done = 0;
    let dispatches = 0;
    for (const a of visible) {
      dispatches += getDispatches(a).length;
      if (isAgentActive(a, agents)) active++;
      else if (a.status === "done") done++;
    }
    return { total: visible.length, dispatches, active, done };
  }, [visible, agents]);

  // When agents transition from none→some, apply the user's default
  // preference (open or collapsed). When they go back to none, reset
  // the manual-toggle flag so the next batch gets the preference again.
  useEffect(() => {
    if (prevVisibleCount.current === 0 && visible.length > 0) {
      // Fresh batch of agents appeared — apply the default preference
      // unless the user already manually toggled this mount.
      if (!userToggled.current) {
        setPanelCollapsed(!agentPanelDefaultOpen);
      }
    }
    if (visible.length === 0) {
      // All agents gone — reset so the next batch gets the default.
      userToggled.current = false;
    }
    prevVisibleCount.current = visible.length;
  }, [visible.length, agentPanelDefaultOpen]);

  /** Force-refetch a conversation, bypassing the "already loaded" guard.
   *  Used by the live poller so an open popup's running dispatch keeps
   *  pulling newly persisted messages as the child agent works. The child
   *  conversation file grows incrementally on disk (the engine saves after
   *  every assistant turn and tool result), so each refetch returns a longer
   *  transcript until the dispatch reaches a terminal state.
   *
   *  `showLoading` gates the "Loading conversation..." placeholder. It is set
   *  only for the initial one-shot load, when there is nothing to show yet. A
   *  BACKGROUND reconcile (the 12s poller, the terminal-transition refetch)
   *  must NOT raise the loading flag: the popup already has a cached transcript
   *  (plus the live push transcript) to display, and flipping loading true on
   *  every poll cycle blanks the panel to the placeholder while the fetch is in
   *  flight — the ~12s flashing between content and "Loading conversation...".
   *  Per the View readiness principle, no loading placeholder for data we have. */
  const refetchConversation = useCallback(
    async (convId: string, showLoading = false) => {
      if (!convId) return;
      if (showLoading) {
        setConvLoading((prev) => {
          const next = new Map(prev);
          next.set(convId, true);
          return next;
        });
      }
      try {
        rDebug("agent-panel", "fetching conversation", {
          conversation_id: convId,
          show_loading: showLoading,
        });
        const data = await window.ion.getConversation(convId, 0, 200);
        const msgs: Message[] = mapConversationMessages(data.messages || []);
        rDebug("agent-panel", "loaded conversation messages", {
          conversation_id: convId,
          count: msgs.length,
        });
        setConvMessages((prev) => {
          const next = new Map(prev);
          next.set(convId, msgs);
          return next;
        });
      } catch (err) {
        rError("agent-panel", "loadConversation error", { error: String(err) });
      } finally {
        if (showLoading) {
          setConvLoading((prev) => {
            const next = new Map(prev);
            next.set(convId, false);
            return next;
          });
        }
      }
    },
    [],
  );

  /** One-shot load: fetch the conversation only if it hasn't been loaded
   *  yet. The live poller uses refetchConversation to force a refresh. */
  const loadSingleConversation = useCallback(
    async (convId: string) => {
      if (!convId || convMessages.has(convId)) return;
      // First load for this conversation — nothing cached yet, so surface the
      // loading placeholder. Background reconciles refetch silently.
      return refetchConversation(convId, true);
    },
    [convMessages, refetchConversation],
  );

  /** Load the conversation for the selected dispatch of an agent,
   *  then lazily preload the remaining dispatches in the background. */
  const loadAgentDispatch = useCallback(
    (agent: AgentStateUpdate, preferredDispatchId?: string) => {
      const dispatches = getDispatches(agent);
      if (dispatches.length === 0) return;
      const dispKey = dispatchKey(agent);
      const preferredIndex = preferredDispatchId
        ? dispatches.findIndex(
            (dispatch) => dispatch.id === preferredDispatchId,
          )
        : -1;
      const idx =
        preferredIndex >= 0
          ? preferredIndex
          : (selectedDispatch.get(dispKey) ?? defaultDispatchIndex(dispatches));
      const convId = dispatches[idx]?.conversationId;
      if (convId) {
        // Load the selected dispatch first, then preload the rest.
        loadSingleConversation(convId)
          .then(() => {
            for (const d of dispatches) {
              if (d.conversationId && d.conversationId !== convId) {
                // Background preload of the remaining dispatches — best-effort.
                void loadSingleConversation(d.conversationId);
              }
            }
          })
          .catch((err) =>
            rError("agent-panel", "load agent dispatch conversation failed", {
              error: String(err),
            }),
          );
      }
    },
    [selectedDispatch, loadSingleConversation, defaultDispatchIndex],
  );

  // Auto-close popup when the agent disappears from the visible set.
  // Matches on `dispatchKey`, the same identity `toggleAgent` opens with, so an
  // agent with no dispatches yet (keyed by name) is found rather than being
  // treated as "gone" the instant it opens.
  useEffect(() => {
    if (!popupSubject) return;
    const owner = visible.find(
      (agent) => agent.name === popupSubject.agentName,
    );
    const stillOwnsDispatch =
      owner &&
      (popupSubject.dispatchId === "" ||
        getDispatches(owner).some(
          (dispatch) => dispatch.id === popupSubject.dispatchId,
        ));
    if (!stillOwnsDispatch) setPopupSubject(null);
  }, [visible, popupSubject]);

  // Resolve by stable agent name + exact dispatch id. Never repoint an open
  // popup just because a newer dispatch became the agent's most recent member.
  const popupAgent = popupSubject
    ? (visible.find(
        (agent) =>
          agent.name === popupSubject.agentName &&
          (popupSubject.dispatchId === "" ||
            getDispatches(agent).some(
              (dispatch) => dispatch.id === popupSubject.dispatchId,
            )),
      ) ?? null)
    : null;
  const popupDispatchSig = popupAgent
    ? `${getDispatches(popupAgent)
        .map((d) => d.conversationId)
        .join(",")}|${popupAgent.status}|${getDispatches(popupAgent).length}`
    : "";
  useEffect(() => {
    if (popupAgent) loadAgentDispatch(popupAgent, popupSubject?.dispatchId);
  }, [popupDispatchSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Slow reconcile for the open popup — the live transcript is carried in real
  // time by the dispatch_activity push path (folded into the store, reconciled
  // in resolveDispatchData). This timer is the CORRECTNESS BACKSTOP, not the
  // streaming path: it re-fetches the file-backed snapshot on a slow cadence so
  // any gap from a dropped delta or reconnect self-heals (the snapshot replaces
  // the cached list and reconcileActivity re-applies surviving push entries).
  // A final reconcile fires once when the dispatch reaches a terminal state so
  // the popup shows the complete persisted transcript regardless of whether the
  // last few deltas landed.
  const popupDispatches = popupAgent ? getDispatches(popupAgent) : [];
  const popupSelIdx = popupAgent
    ? popupDispatches.findIndex(
        (dispatch) => dispatch.id === popupSubject?.dispatchId,
      )
    : -1;
  const popupSelDispatch =
    popupSelIdx >= 0 ? popupDispatches[popupSelIdx] : undefined;
  const popupSelConvId = popupSelDispatch?.conversationId || "";
  // Treat the dispatch as running when its own status is running, or (when the
  // structured entry has no status yet) when the agent itself is running.
  const popupSelRunning = popupAgent
    ? popupSelDispatch?.status
      ? popupSelDispatch.status === "running"
      : popupAgent.status === "running"
    : false;
  const RECONCILE_INTERVAL_MS = 12000;
  useEffect(() => {
    if (!popupSubject || !popupSelConvId || !popupSelRunning) return;
    const timer = setInterval(() => {
      refetchConversation(popupSelConvId).catch((err) =>
        rDebug("agent-panel", "popup reconcile refetch failed", {
          conversation_id: popupSelConvId,
          error: String(err),
        }),
      );
    }, RECONCILE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [popupSubject, popupSelConvId, popupSelRunning, refetchConversation]);
  // One final reconcile when the running dispatch transitions to terminal, so
  // the popup converges on the complete persisted transcript.
  const prevPopupRunning = useRef(false);
  useEffect(() => {
    if (
      popupSubject &&
      popupSelConvId &&
      prevPopupRunning.current &&
      !popupSelRunning
    ) {
      refetchConversation(popupSelConvId).catch((err) =>
        rDebug("agent-panel", "final popup reconcile refetch failed", {
          conversation_id: popupSelConvId,
          error: String(err),
        }),
      );
    }
    prevPopupRunning.current = popupSelRunning;
  }, [popupSubject, popupSelConvId, popupSelRunning, refetchConversation]);

  /** Resolve dispatch data for a given agent (used by the row and the popup). */
  const resolveDispatchData = useCallback(
    (agent: AgentStateUpdate, preferredDispatchId?: string) => {
      const dispatches = getDispatches(agent);
      const dispKey = dispatchKey(agent);
      const preferredIndex = preferredDispatchId
        ? dispatches.findIndex(
            (dispatch) => dispatch.id === preferredDispatchId,
          )
        : -1;
      const dispIdx =
        preferredIndex >= 0
          ? preferredIndex
          : (selectedDispatch.get(dispKey) ?? defaultDispatchIndex(dispatches));
      const activeConvId = dispatches[dispIdx]?.conversationId || "";
      const rawMsgs = activeConvId ? convMessages.get(activeConvId) : undefined;
      const activeDispatch = dispatches[dispIdx];
      const isLoading = activeConvId
        ? convLoading.get(activeConvId) || false
        : false;
      // Reconcile the file-backed snapshot (rawMsgs) with the live push
      // transcript (dispatchActivity). The snapshot is authoritative and heals
      // any gap; push entries the snapshot does not yet cover (the live in-flight
      // partial) are appended so the popup streams in real time. When no snapshot
      // has loaded yet, the push entries alone drive the popup.
      // Look up by dispatchAgentId (activeDispatch.id) so two dispatches that
      // share a conversationId read from separate push buffers. convId-keying
      // caused dispatch 1's entries to appear in dispatch 2's popup.
      const pushMsgs = activeDispatch?.id
        ? dispatchActivity?.[activeDispatch.id]
        : undefined;
      let mergedMsgs = rawMsgs;
      if (pushMsgs && pushMsgs.length > 0) {
        mergedMsgs = reconcileActivity(rawMsgs ?? [], {
          order: pushMsgs.map((_, i) => `idx:${i}`),
          entries: Object.fromEntries(
            pushMsgs.map((m, i) => [
              `idx:${i}`,
              { key: `idx:${i}`, seq: i, ts: m.timestamp ?? 0, message: m },
            ]),
          ),
        });
      }
      return { dispatches, dispIdx, slicedMsgs: mergedMsgs, isLoading };
    },
    [
      selectedDispatch,
      convMessages,
      convLoading,
      dispatchActivity,
      defaultDispatchIndex,
    ],
  );

  // Click-to-inspect from the Agent Team Visualizer (see the hook).
  useAgentDetailOpener(agents, (name, agent) => toggleAgent(name, agent));

  const toggleAgent = (name: string, agent: AgentStateUpdate) => {
    // Per-agent UI state (expand/select/popup) is keyed by the agent's most
    // recent dispatch id, not its name, so two dispatches of the same agent
    // name maintain independent state. Falls back to the name for agents with
    // no dispatch.
    const key = dispatchKey(agent);
    // Whether this row has anything to show: at least one dispatch, buffered
    // full output, or a live running state. Shared by the popup and inline
    // paths. A data-less row (roster pill, completed ephemeral with no
    // transcript) is a no-op click — matching iOS (ConversationView+Agents:91)
    // and avoiding the empty "No conversation data available" expansion.
    const hasContent =
      getDispatches(agent).length > 0 ||
      meta(agent, "fullOutput", "") ||
      agent.status === "running";
    // Escalation mode: when an onOpenDispatch handler is provided (the embedded
    // sub-dispatch panel inside the dispatch-preview popup), clicking a row
    // drills one tier down via the parent popup's breadcrumb stack instead of
    // opening AgentPanel's own floating detail panel. Resolve the agent's
    // selected dispatch (default: most recent) and hand it up.
    if (onOpenDispatch) {
      const dispatches = getDispatches(agent);
      if (dispatches.length > 0) {
        const idx =
          selectedDispatch.get(key) ?? defaultDispatchIndex(dispatches);
        const dispatch = dispatches[idx];
        if (dispatch) {
          onOpenDispatch(dispatch, agent);
          return;
        }
      }
      return;
    }

    // Opening a row shows dispatch detail in the active client host. Studio
    // routes it to the surface. Overlay uses the floating detail panel.
    if (hasContent) {
      // Default to the most recent dispatch if not already selected
      const dispatches = getDispatches(agent);
      const selectedIndex =
        selectedDispatch.get(key) ?? defaultDispatchIndex(dispatches);
      const selected = dispatches[selectedIndex];
      if (routeAgentDetailToSurface(agent, selected)) {
        loadAgentDispatch(agent, selected.id);
        return;
      }
      if (dispatches.length > 0 && !selectedDispatch.has(key)) {
        setSelectedDispatch((prev) => {
          const next = new Map(prev);
          next.set(key, defaultDispatchIndex(dispatches));
          return next;
        });
      }
      // Open under `key` (dispatchKey), the identity the popup lookups match
      // on. A running agent whose first dispatch has not registered yet is
      // keyed by name; keying it any other way opened a panel that resolved to
      // no agent and so never rendered.
      setPopupSubject({
        agentName: agent.name,
        dispatchId: selected?.id ?? "",
      });
      loadAgentDispatch(agent, selected?.id);
    }
    // A data-less click (roster pill, completed ephemeral with no transcript)
    // is a no-op — there is nothing to open.
  };

  // Drag-to-resize handler (mechanics extracted to keep this file under cap).
  const handleDragStart = useAgentPanelResize(panelHeight, onPanelHeightChange);

  // All hooks above — safe to return early now.
  if (agents.length === 0 && !alwaysRender) return null;

  const popupData = popupAgent
    ? resolveDispatchData(popupAgent, popupSubject?.dispatchId)
    : null;
  const onTogglePanel = () => {
    userToggled.current = true;
    setPanelCollapsed(!panelCollapsed);
  };
  const onSelectDispatch = (idx: number) => {
    if (!popupAgent || !popupData) return;
    setSelectedDispatch((prev) => {
      const next = new Map(prev);
      next.set(dispatchKey(popupAgent), idx);
      return next;
    });
    const selected = popupData.dispatches[idx];
    if (selected) {
      setPopupSubject({
        agentName: popupAgent.name,
        dispatchId: selected.id,
      });
    }
    const convId = selected?.conversationId;
    if (convId) {
      loadSingleConversation(convId).catch((err) =>
        rError(
          "agent-panel",
          "popup select dispatch load conversation failed",
          {
            conversation_id: convId,
            error: String(err),
          },
        ),
      );
    }
  };

  return (
    <AgentPanelView
      colors={colors}
      panelRef={panelRef}
      agents={agents}
      visible={visible}
      dispatchTelemetry={dispatchTelemetry}
      agentDepths={agentDepths}
      selectedDispatch={selectedDispatch}
      defaultDispatchIndex={defaultDispatchIndex}
      panelCollapsed={panelCollapsed}
      onTogglePanel={onTogglePanel}
      isFullscreen={isFullscreen}
      onToggleFullscreen={onToggleFullscreen}
      panelHeight={panelHeight}
      onPanelHeightChange={onPanelHeightChange}
      handleDragStart={handleDragStart}
      headerCounts={headerCounts}
      subDispatch={subDispatch}
      tabId={tabId}
      onToggleAgent={(agent) => toggleAgent(agent.name, agent)}
      popupAgent={popupAgent}
      popupData={popupData}
      onSelectDispatch={onSelectDispatch}
      onClosePopup={() => setPopupSubject(null)}
    />
  );
}
