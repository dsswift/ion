import React, { useState, useEffect, useRef, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CaretRight, ArrowsOutSimple, ArrowsInSimple } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { useSessionStore } from '../stores/sessionStore'
import { meta, isAgentVisible, isRootLevelAgent, sortAgents, getDispatches, selectAgentDepths, dispatchKey } from './agent-panel-helpers'
import { reconcileActivity } from './agent-dispatch-activity'
import { mapConversationMessages } from './agent-conversation-mapper'
import { AgentRow } from './AgentRow'
import { AgentDetailPanel } from './AgentDetailPanel'
import { useAgentDetailOpener } from '../hooks/useAgentDetailOpener'
import { useAgentPanelResize, DEFAULT_PANEL_HEIGHT } from './agent-panel-resize'
import type { AgentStateUpdate } from '../../shared/types'
import type { Message } from '../../shared/types'
import type { DispatchInfo, DispatchTelemetryEntry } from '../../shared/types-engine'
import { rDebug, rError } from '../rendererLogger'

interface Props {
  agents: AgentStateUpdate[]
  /** Flat dispatch telemetry entries for deriving nesting depth. */
  dispatchTelemetry?: DispatchTelemetryEntry[]
  isFullscreen?: boolean
  onToggleFullscreen?: () => void
  /** Custom panel height in pixels (rows container). Undefined = default. */
  panelHeight?: number
  /** Called when the user drags the resize handle to a new height. */
  onPanelHeightChange?: (height: number) => void
  /**
   * Main-conversation scope: show only the orchestrator's ROOT dispatches
   * (agents whose dispatch telemetry has no parent). Sub-dispatched (depth-2+)
   * agents are excluded so they never surface in the main panel. The embedded
   * popup panel leaves this false — its agent set is already child-scoped.
   */
  rootOnly?: boolean
  /**
   * Sub-dispatch scope: this panel renders a tier BELOW the orchestrator
   * (inside the dispatch-preview popup). Visibility is a top-level-only concept
   * (`isAgentVisible`); sub-dispatched agents always show regardless of their
   * `visibility` metadata, so the visibility filter is bypassed here. The main
   * conversation panel leaves this false to preserve always/sticky/ephemeral.
   */
  subDispatch?: boolean
  /**
   * When provided, clicking an agent row escalates to this callback instead of
   * opening AgentPanel's own internal detail popup. The dispatch-preview popup
   * passes this so a click drills one tier down and pushes onto its breadcrumb
   * stack, rather than spawning a second floating panel.
   */
  onOpenDispatch?: (dispatch: DispatchInfo, agent: AgentStateUpdate) => void
  /**
   * Render the panel chrome (the "Agents (N)" header) even when there are zero
   * agents. The dispatch-preview popup sets this so the embedded panel is always
   * present in the preview; the main conversation panel leaves it false so a
   * conversation with no agents shows no empty panel.
   */
  alwaysRender?: boolean
}

export function AgentPanel({ agents, dispatchTelemetry, isFullscreen, onToggleFullscreen, panelHeight, onPanelHeightChange, rootOnly, subDispatch, onOpenDispatch, alwaysRender }: Props) {
  const colors = useColors()
  const agentPanelDefaultOpen = usePreferencesStore((s) => s.agentPanelDefaultOpen)
  const agentDetailPopup = usePreferencesStore((s) => s.agentDetailPopup)
  // Live push transcript, keyed by child conversationId. Folded from
  // dispatch_activity deltas in the engine-event slice; reconciled with the
  // file-backed snapshot below.
  const dispatchActivity = useSessionStore((s) => s.dispatchActivity)
  // Keyed by DISPATCH ID (not agent name): two dispatches of the same agent
  // name must maintain independent expand state. Falls back to the agent name
  // when the agent carries no dispatch (extension-roster rows, pre-fix state).
  const [agentExpanded, setAgentExpanded] = useState<Map<string, boolean>>(new Map())
  const [panelCollapsed, setPanelCollapsed] = useState(true)
  // Keyed by conversationId — each dispatch's conversation is loaded independently
  const [convMessages, setConvMessages] = useState<Map<string, Message[]>>(new Map())
  const [convLoading, setConvLoading] = useState<Map<string, boolean>>(new Map())
  // Track which dispatch index is selected, keyed by DISPATCH ID (see above).
  const [selectedDispatch, setSelectedDispatch] = useState<Map<string, number>>(new Map())
  // Popup state — which dispatch (by dispatch id) is shown in the floating panel
  const [popupDispatchId, setPopupDispatchId] = useState<string | null>(null)
  const prevVisibleCount = useRef(0)
  // Tracks whether the user manually toggled the panel this "session"
  // (since agents last appeared). Reset when agents go from 0→N so the
  // default-open preference drives the initial state on each fresh batch.
  const userToggled = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)

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
    const visibilityFiltered = subDispatch ? agents : agents.filter(isAgentVisible)
    const scoped = rootOnly
      ? visibilityFiltered.filter(isRootLevelAgent)
      : visibilityFiltered
    return sortAgents(scoped)
  }, [agents, subDispatch, rootOnly])

  // Derive per-agent nesting depth from flat dispatch telemetry.
  const agentDepths = React.useMemo(
    () => selectAgentDepths(dispatchTelemetry || []),
    [dispatchTelemetry],
  )

  // Header breakdown — total / active / done, derived over the SAME filtered
  // `visible` set the list renders (not the raw `agents` array) so the header
  // stays honest against the rows below it. Ephemeral agents drop out of
  // `visible` when they finish, so `done` counts only the always/sticky agents
  // that completed and remain clickable in the list. `error` folds into neither
  // active nor done — it is surfaced by its own red row dot.
  const headerCounts = React.useMemo(() => {
    let active = 0
    let done = 0
    for (const a of visible) {
      if (a.status === 'running') active++
      else if (a.status === 'done') done++
    }
    return { total: visible.length, active, done }
  }, [visible])

  // When agents transition from none→some, apply the user's default
  // preference (open or collapsed). When they go back to none, reset
  // the manual-toggle flag so the next batch gets the preference again.
  useEffect(() => {
    if (prevVisibleCount.current === 0 && visible.length > 0) {
      // Fresh batch of agents appeared — apply the default preference
      // unless the user already manually toggled this mount.
      if (!userToggled.current) {
        setPanelCollapsed(!agentPanelDefaultOpen)
      }
    }
    if (visible.length === 0) {
      // All agents gone — reset so the next batch gets the default.
      userToggled.current = false
    }
    prevVisibleCount.current = visible.length
  }, [visible.length, agentPanelDefaultOpen])

  /** Force-refetch a conversation, bypassing the "already loaded" guard.
   *  Used by the live poller so an open popup's running dispatch keeps
   *  pulling newly persisted messages as the child agent works. The child
   *  conversation file grows incrementally on disk (the engine saves after
   *  every assistant turn and tool result), so each refetch returns a longer
   *  transcript until the dispatch reaches a terminal state. */
  const refetchConversation = useCallback(async (convId: string) => {
    if (!convId) return
    setConvLoading(prev => { const next = new Map(prev); next.set(convId, true); return next })
    try {
      rDebug('agent-panel', 'fetching conversation', { conversation_id: convId })
      const data = await window.ion.getConversation(convId, 0, 200)
      const msgs: Message[] = mapConversationMessages(data.messages || [])
      rDebug('agent-panel', 'loaded conversation messages', { conversation_id: convId, count: msgs.length })
      setConvMessages(prev => { const next = new Map(prev); next.set(convId, msgs); return next })
    } catch (err) {
      rError('agent-panel', 'loadConversation error', { error: String(err) })
    } finally {
      setConvLoading(prev => { const next = new Map(prev); next.set(convId, false); return next })
    }
  }, [])

  /** One-shot load: fetch the conversation only if it hasn't been loaded
   *  yet. The live poller uses refetchConversation to force a refresh. */
  const loadSingleConversation = useCallback(async (convId: string) => {
    if (!convId || convMessages.has(convId)) return
    return refetchConversation(convId)
  }, [convMessages, refetchConversation])

  /** Load the conversation for the selected dispatch of an agent,
   *  then lazily preload the remaining dispatches in the background. */
  const loadAgentDispatch = useCallback((agent: AgentStateUpdate) => {
    const dispatches = getDispatches(agent)
    if (dispatches.length === 0) return
    const dispKey = dispatches.at(-1)?.id ?? agent.name
    const idx = selectedDispatch.get(dispKey) ?? dispatches.length - 1
    const convId = dispatches[idx]?.conversationId
    if (convId) {
      // Load the selected dispatch first, then preload the rest.
      loadSingleConversation(convId).then(() => {
        for (const d of dispatches) {
          if (d.conversationId && d.conversationId !== convId) {
            loadSingleConversation(d.conversationId)
          }
        }
      })
    }
  }, [selectedDispatch, loadSingleConversation])

  // Re-fetch conversation when an expanded agent transitions to a terminal state
  // or when its conversationIds change (new dispatch completed). This handles
  // the case where a user expands a running agent (no conversationId yet), then
  // the agent completes — and also re-fetches when a second dispatch adds a new
  // conversation ID to the accumulated list.
  useEffect(() => {
    for (const agent of visible) {
      const isExpanded = agentExpanded.get(dispatchKey(agent))
      const isTerminal = agent.status === 'done' || agent.status === 'error'
      const hasAnyConvId = getDispatches(agent).some(d => d.conversationId)
      if (isExpanded && isTerminal && hasAnyConvId) {
        loadAgentDispatch(agent)
      }
    }
  }, [visible, agentExpanded, loadAgentDispatch])

  // Auto-close popup when the agent disappears from the visible set
  useEffect(() => {
    if (popupDispatchId && !visible.find(a => getDispatches(a).at(-1)?.id === popupDispatchId)) {
      setPopupDispatchId(null)
    }
  }, [visible, popupDispatchId])

  // Live streaming for popup — re-fetch when dispatch signature changes
  const popupAgent = popupDispatchId ? visible.find(a => getDispatches(a).at(-1)?.id === popupDispatchId) : null
  const popupDispatchSig = popupAgent
    ? `${getDispatches(popupAgent).map(d => d.conversationId).join(',')}|${popupAgent.status}|${getDispatches(popupAgent).length}`
    : ''
  useEffect(() => {
    if (popupAgent) loadAgentDispatch(popupAgent)
  }, [popupDispatchSig]) // eslint-disable-line react-hooks/exhaustive-deps

  // Slow reconcile for the open popup — the live transcript is carried in real
  // time by the dispatch_activity push path (folded into the store, reconciled
  // in resolveDispatchData). This timer is the CORRECTNESS BACKSTOP, not the
  // streaming path: it re-fetches the file-backed snapshot on a slow cadence so
  // any gap from a dropped delta or reconnect self-heals (the snapshot replaces
  // the cached list and reconcileActivity re-applies surviving push entries).
  // A final reconcile fires once when the dispatch reaches a terminal state so
  // the popup shows the complete persisted transcript regardless of whether the
  // last few deltas landed.
  const popupDispatches = popupAgent ? getDispatches(popupAgent) : []
  const popupSelIdx = popupAgent
    ? (selectedDispatch.get(dispatchKey(popupAgent)) ?? popupDispatches.length - 1)
    : -1
  const popupSelDispatch = popupSelIdx >= 0 ? popupDispatches[popupSelIdx] : undefined
  const popupSelConvId = popupSelDispatch?.conversationId || ''
  // Treat the dispatch as running when its own status is running, or (when the
  // structured entry has no status yet) when the agent itself is running.
  const popupSelRunning = popupAgent
    ? (popupSelDispatch?.status
        ? popupSelDispatch.status === 'running'
        : popupAgent.status === 'running')
    : false
  const RECONCILE_INTERVAL_MS = 12000
  useEffect(() => {
    if (!popupDispatchId || !popupSelConvId || !popupSelRunning) return
    const timer = setInterval(() => {
      refetchConversation(popupSelConvId)
    }, RECONCILE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [popupDispatchId, popupSelConvId, popupSelRunning, refetchConversation])
  // One final reconcile when the running dispatch transitions to terminal, so
  // the popup converges on the complete persisted transcript.
  const prevPopupRunning = useRef(false)
  useEffect(() => {
    if (popupDispatchId && popupSelConvId && prevPopupRunning.current && !popupSelRunning) {
      refetchConversation(popupSelConvId)
    }
    prevPopupRunning.current = popupSelRunning
  }, [popupDispatchId, popupSelConvId, popupSelRunning, refetchConversation])

  /** Check if any conversation is currently loading for an agent. */
  const isAgentLoading = useCallback((agent: AgentStateUpdate): boolean => {
    const dispatches = getDispatches(agent)
    return dispatches.some(d => d.conversationId && convLoading.get(d.conversationId))
  }, [convLoading])

  /** Resolve dispatch data for a given agent (used by both inline and popup). */
  const resolveDispatchData = useCallback((agent: AgentStateUpdate) => {
    const dispatches = getDispatches(agent)
    const dispKey = dispatches.at(-1)?.id ?? agent.name
    const dispIdx = selectedDispatch.get(dispKey) ?? dispatches.length - 1
    const activeConvId = dispatches[dispIdx]?.conversationId || ''
    const rawMsgs = activeConvId ? convMessages.get(activeConvId) : undefined
    const activeDispatch = dispatches[dispIdx]
    const isLoading = activeConvId ? convLoading.get(activeConvId) || false : false
    // Reconcile the file-backed snapshot (rawMsgs) with the live push
    // transcript (dispatchActivity). The snapshot is authoritative and heals
    // any gap; push entries the snapshot does not yet cover (the live in-flight
    // partial) are appended so the popup streams in real time. When no snapshot
    // has loaded yet, the push entries alone drive the popup.
    // Look up by dispatchAgentId (activeDispatch.id) so two dispatches that
    // share a conversationId read from separate push buffers. convId-keying
    // caused dispatch 1's entries to appear in dispatch 2's popup.
    const pushMsgs = activeDispatch?.id ? dispatchActivity?.[activeDispatch.id] : undefined
    let mergedMsgs = rawMsgs
    if (pushMsgs && pushMsgs.length > 0) {
      mergedMsgs = reconcileActivity(rawMsgs ?? [], {
        order: pushMsgs.map((_, i) => `idx:${i}`),
        entries: Object.fromEntries(pushMsgs.map((m, i) => [`idx:${i}`, { key: `idx:${i}`, seq: i, ts: m.timestamp ?? 0, message: m }])),
      })
    }
    return { dispatches, dispIdx, slicedMsgs: mergedMsgs, isLoading }
  }, [selectedDispatch, convMessages, convLoading, dispatchActivity])

  // Click-to-inspect from the Agent Team Visualizer (see the hook).
  useAgentDetailOpener(agents, (name, agent) => toggleAgent(name, agent))

  const toggleAgent = (name: string, agent: AgentStateUpdate) => {
    // Per-agent UI state (expand/select/popup) is keyed by the agent's most
    // recent dispatch id, not its name, so two dispatches of the same agent
    // name maintain independent state. Falls back to the name for agents with
    // no dispatch.
    const key = dispatchKey(agent)
    // Whether this row has anything to show: at least one dispatch, buffered
    // full output, or a live running state. Shared by the popup and inline
    // paths. A data-less row (roster pill, completed ephemeral with no
    // transcript) is a no-op click — matching iOS (ConversationView+Agents:91)
    // and avoiding the empty "No conversation data available" expansion.
    const hasContent = getDispatches(agent).length > 0 || meta(agent, 'fullOutput', '') || agent.status === 'running'
    // Escalation mode: when an onOpenDispatch handler is provided (the embedded
    // sub-dispatch panel inside the dispatch-preview popup), clicking a row
    // drills one tier down via the parent popup's breadcrumb stack instead of
    // opening AgentPanel's own floating detail panel. Resolve the agent's
    // selected dispatch (default: most recent) and hand it up.
    if (onOpenDispatch) {
      const dispatches = getDispatches(agent)
      if (dispatches.length > 0) {
        const idx = selectedDispatch.get(key) ?? dispatches.length - 1
        const dispatch = dispatches[idx]
        if (dispatch) {
          onOpenDispatch(dispatch, agent)
          return
        }
      }
      return
    }

    // Popup mode: open floating panel instead of inline expand
    if (agentDetailPopup) {
      if (hasContent) {
        // Default to the most recent dispatch if not already selected
        const dispatches = getDispatches(agent)
        const mostRecentDispatch = dispatches.at(-1)
        if (dispatches.length > 0 && !selectedDispatch.has(key)) {
          setSelectedDispatch(prev => { const next = new Map(prev); next.set(key, dispatches.length - 1); return next })
        }
        setPopupDispatchId(mostRecentDispatch?.id ?? name)
        loadAgentDispatch(agent)
      }
      // Popup mode never falls through to inline expansion — a data-less click
      // is a no-op here too.
      return
    }

    // Inline expand mode (original behavior). A data-less row does not expand.
    if (!hasContent) return
    const isCurrentlyExpanded = agentExpanded.get(key) || false
    // If already expanded and a conversation is loading, ignore the click.
    // This prevents the user from accidentally collapsing the panel and
    // restarting the same slow fetch by clicking impatiently.
    if (isCurrentlyExpanded && isAgentLoading(agent)) return
    const willExpand = !isCurrentlyExpanded
    setAgentExpanded((prev) => {
      const next = new Map(prev)
      next.set(key, willExpand)
      return next
    })
    if (willExpand) {
      // Default to the most recent dispatch (last in array)
      const dispatches = getDispatches(agent)
      if (dispatches.length > 0 && !selectedDispatch.has(key)) {
        setSelectedDispatch(prev => { const next = new Map(prev); next.set(key, dispatches.length - 1); return next })
      }
      loadAgentDispatch(agent)
    }
  }

  // Drag-to-resize handler (mechanics extracted to keep this file under cap).
  const handleDragStart = useAgentPanelResize(panelHeight, onPanelHeightChange)

  // All hooks above — safe to return early now.
  // The main-conversation panel self-hides when the conversation has no agents
  // (so a plain conversation shows no empty panel). The dispatch-preview popup
  // passes alwaysRender so its embedded panel is always present — showing
  // "Agents (0)" before the lead dispatches anyone, then populating as
  // specialists spawn (the user requires the preview to always carry the panel).
  if (agents.length === 0 && !alwaysRender) return null

  const effectiveHeight = panelHeight ?? DEFAULT_PANEL_HEIGHT

  // Resolve popup data (outside the render loop, using the same logic)
  const popupData = popupAgent ? resolveDispatchData(popupAgent) : null

  return (
    <div
      ref={panelRef}
      data-ion-ui
      style={{
        borderTop: `1px solid ${colors.containerBorder}`,
        flexShrink: 0,
      }}
    >
      {/* Drag handle for resizing */}
      {onPanelHeightChange && !panelCollapsed && !isFullscreen && (
        <div
          onMouseDown={handleDragStart}
          style={{
            height: 4,
            cursor: 'ns-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{
            width: 32,
            height: 2,
            borderRadius: 1,
            background: colors.textTertiary,
            opacity: 0.3,
            transition: 'opacity 0.15s',
          }} />
        </div>
      )}

      {/* Collapsible header */}
      <div
        data-ion-ui
        onClick={() => { userToggled.current = true; setPanelCollapsed(!panelCollapsed) }}
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 20,
          padding: '0 8px',
          cursor: 'pointer',
          userSelect: 'none',
          fontSize: 10,
          color: colors.textTertiary,
          gap: 4,
        }}
      >
        <CaretRight
          size={8}
          style={{
            transform: panelCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
            transition: 'transform 0.15s ease',
          }}
        />
        {/*
          Segmented breakdown: total · active · done. Each count segment uses
          the same status token as its corresponding row dot (active → orange
          statusRunning, done → green statusComplete) so the header's color
          vocabulary matches the rows. Zero segments are dropped, so a running
          batch reads "Agents · 5 · 5 active" and a finished one "Agents · 5 ·
          5 done". Counts are derived over `visible` (see headerCounts memo).
        */}
        <span>Agents · {headerCounts.total}</span>
        {headerCounts.active > 0 && (
          <span style={{ color: colors.statusRunning, fontWeight: 600 }}>· {headerCounts.active} active</span>
        )}
        {headerCounts.done > 0 && (
          <span style={{ color: colors.statusComplete, fontWeight: 600 }}>· {headerCounts.done} done</span>
        )}
        {onToggleFullscreen && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onToggleFullscreen()
            }}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: colors.textTertiary,
              display: 'flex',
              alignItems: 'center',
              marginLeft: 'auto',
            }}
            title={isFullscreen ? 'Collapse agent panel' : 'Expand agent panel'}
          >
            {isFullscreen ? <ArrowsInSimple size={10} /> : <ArrowsOutSimple size={10} />}
          </button>
        )}
      </div>

      {/* Agent rows */}
      <AnimatePresence>
        {!panelCollapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            style={{
              overflow: 'hidden',
              maxHeight: isFullscreen ? undefined : effectiveHeight,
              overflowY: 'auto',
            }}
          >
            {visible.map((agent) => {
              const key = dispatchKey(agent)
              const isExpanded = agentExpanded.get(key) || false
              const { dispatches, dispIdx, slicedMsgs: loadedMsgs, isLoading } = resolveDispatchData(agent)
              const nestDepth = agentDepths.get(getDispatches(agent).at(-1)?.id ?? '') ?? 0
              const nestIndent = nestDepth > 1 ? (nestDepth - 1) * 16 : 0

              return (
                <AgentRow
                  key={key}
                  agent={agent}
                  allAgents={agents}
                  colors={colors}
                  isFullscreen={isFullscreen}
                  isExpanded={isExpanded}
                  dispatches={dispatches}
                  dispIdx={dispIdx}
                  loadedMessages={loadedMsgs}
                  loading={isLoading}
                  nestIndent={nestIndent}
                  onToggle={() => toggleAgent(agent.name, agent)}
                  onSelectDispatch={(idx) => {
                    setSelectedDispatch(prev => { const next = new Map(prev); next.set(key, idx); return next })
                    const convId = dispatches[idx]?.conversationId
                    if (convId) loadSingleConversation(convId)
                  }}
                />
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating detail panel (popup mode) */}
      {popupAgent && popupData && (
        <AgentDetailPanel
          agent={popupAgent}
          loadedMessages={popupData.slicedMsgs}
          loading={popupData.isLoading}
          dispatches={popupData.dispatches}
          selectedDispatch={popupData.dispIdx}
          onSelectDispatch={(idx) => {
            setSelectedDispatch(prev => { const next = new Map(prev); next.set(dispatchKey(popupAgent), idx); return next })
            const convId = popupData.dispatches[idx]?.conversationId
            if (convId) loadSingleConversation(convId)
          }}
          onClose={() => setPopupDispatchId(null)}
          dispatchTelemetry={dispatchTelemetry}
          allAgents={agents}
        />
      )}
    </div>
  )
}
