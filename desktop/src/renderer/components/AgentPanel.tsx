import React, { useState, useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CaretRight, ArrowsOutSimple, ArrowsInSimple } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { useSessionStore } from '../stores/sessionStore'
import { meta, isAgentVisible, isRootLevelAgent, sortAgents, getDispatches, selectAgentDepths, dispatchKey, isAgentActive, mostRecentDispatch } from './agent-panel-helpers'
import { useDispatchTranscript, resolveSubjectAgent } from '../hooks/useDispatchTranscript'
import { windowRole } from '../lib/window-role'
import { AgentRow } from './AgentRow'
import { AgentDetailPanel } from './AgentDetailPanel'
import { useAgentDetailOpener } from '../hooks/useAgentDetailOpener'
import { useAgentPanelResize, DEFAULT_PANEL_HEIGHT } from './agent-panel-resize'
import type { AgentStateUpdate } from '../../shared/types'
import type { DispatchInfo, DispatchTelemetryEntry } from '../../shared/types-engine'
import { rError } from '../rendererLogger'

interface Props {
  /** Agents rendered as rows in this panel tier. */
  agents: AgentStateUpdate[]
  /** Full dispatch tree. Rows use it for cross-tier context. */
  allAgents?: AgentStateUpdate[]
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

export function AgentPanel({ agents, allAgents = agents, dispatchTelemetry, isFullscreen, onToggleFullscreen, panelHeight, onPanelHeightChange, rootOnly, subDispatch, onOpenDispatch, alwaysRender }: Props) {
  const colors = useColors()
  const agentPanelDefaultOpen = usePreferencesStore((s) => s.agentPanelDefaultOpen)
  const [panelCollapsed, setPanelCollapsed] = useState(true)
  // Popup subject stays tied to the exact dispatch the operator opened. Agent
  // snapshots can reorder history or add a newer dispatch; deriving the popup
  // from dispatchKey(agent) would silently repoint an open panel.
  const [popupSubject, setPopupSubject] = useState<{ agentName: string; dispatchId: string } | null>(null)
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
    return sortAgents(scoped, allAgents)
  }, [agents, allAgents, subDispatch, rootOnly])

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
  //
  // ACTIVE is `isAgentActive`, not the row's own status: an agent counts as
  // active when it is running/suspended OR when any of its dispatches still
  // owns a live descendant. Reading the bare status is how a live tree once
  // showed "3 done" with no active segment while a specialist under a finished
  // dispatch was still working — the same defect the row's background dot
  // fixes, so the two must agree. `done` therefore also excludes rows that are
  // terminal but still waiting on a descendant.
  const headerCounts = React.useMemo(() => {
    let active = 0
    let done = 0
    let dispatches = 0
    for (const a of visible) {
      dispatches += getDispatches(a).length
      if (isAgentActive(a, allAgents)) active++
      else if (a.status === 'done') done++
    }
    return { total: visible.length, dispatches, active, done }
  }, [visible, allAgents])

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

  // One streaming/reconcile implementation, two hosts (overlay popup +
  // Studio split): the transcript machinery lives in useDispatchTranscript.
  const popupAgentForHook = resolveSubjectAgent(visible, popupSubject)
  const {
    loadSingleConversation,
    loadAgentDispatch,
    resolveDispatchData,
    selectedDispatch,
    setSelectedDispatch,
    defaultDispatchIndex,
  } = useDispatchTranscript(popupSubject, popupAgentForHook)

  // Auto-close popup when the agent disappears from the visible set.
  // Matches on `dispatchKey`, the same identity `toggleAgent` opens with, so an
  // agent with no dispatches yet (keyed by name) is found rather than being
  // treated as "gone" the instant it opens.
  useEffect(() => {
    if (!popupSubject) return
    const owner = visible.find(a => a.name === popupSubject.agentName)
    const stillOwnsDispatch = owner && (popupSubject.dispatchId === '' || getDispatches(owner).some(d => d.id === popupSubject.dispatchId))
    if (!stillOwnsDispatch) setPopupSubject(null)
  }, [visible, popupSubject])

  // Resolve by stable agent name + exact dispatch id. Never repoint an open
  // popup just because a newer dispatch became the agent's most recent member.
  const popupAgent = popupSubject
    ? visible.find(a => a.name === popupSubject.agentName && (popupSubject.dispatchId === '' || getDispatches(a).some(d => d.id === popupSubject.dispatchId))) ?? null
    : null
  // Reload-on-change + the 12s reconcile + final terminal reconcile all
  // live inside useDispatchTranscript now (signature-keyed on the subject
  // agent's dispatch set/status — heartbeat-safe).

  // Click-to-inspect from the Ion Studio (see the hook).
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
        const idx = selectedDispatch.get(key) ?? defaultDispatchIndex(dispatches)
        const dispatch = dispatches[idx]
        if (dispatch) {
          onOpenDispatch(dispatch, agent)
          return
        }
      }
      return
    }

    // Opening a row always means opening the floating detail panel. There is
    // no inline-expand mode: the detail panel is the single way to inspect a
    // dispatch, so the collapsed row stays a pure status summary.
    if (hasContent) {
      // Default to the most recent dispatch if not already selected
      const dispatches = getDispatches(agent)
      if (dispatches.length > 0 && !selectedDispatch.has(key)) {
        setSelectedDispatch(prev => { const next = new Map(prev); next.set(key, defaultDispatchIndex(dispatches)); return next })
      }
      // Open under `key` (dispatchKey), the identity the popup lookups match
      // on. A running agent whose first dispatch has not registered yet is
      // keyed by name; keying it any other way opened a panel that resolved to
      // no agent and so never rendered.
      const selectedIndex = selectedDispatch.get(key) ?? defaultDispatchIndex(dispatches)
      const subject = { agentName: agent.name, dispatchId: dispatches[selectedIndex]?.id ?? '' }
      // Branch at the click, not the component: Studio renders the dispatch
      // preview as an inline split beside the conversation (never a floating
      // popup); the overlay keeps the FloatingPanel popup.
      if (windowRole() === 'studio') {
        useSessionStore.getState().openDispatchSplit(subject)
        return
      }
      setPopupSubject(subject)
      loadAgentDispatch(agent)
    }
    // A data-less click (roster pill, completed ephemeral with no transcript)
    // is a no-op — there is nothing to open.
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
  const popupData = popupAgent ? resolveDispatchData(popupAgent, popupSubject?.dispatchId) : null

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
        <span>{subDispatch ? 'Child agents' : 'Agents'} · {headerCounts.total}</span>
        <span>· {headerCounts.dispatches} {headerCounts.dispatches === 1 ? 'dispatch' : 'dispatches'}</span>
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
              const nestDepth = agentDepths.get(mostRecentDispatch(getDispatches(agent))?.id ?? '') ?? 0
              const nestIndent = nestDepth > 1 ? (nestDepth - 1) * 16 : 0

              return (
                <AgentRow
                  key={key}
                  agent={agent}
                  allAgents={allAgents}
                  colors={colors}
                  nestIndent={nestIndent}
                  onToggle={() => toggleAgent(agent.name, agent)}
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
            const selected = popupData.dispatches[idx]
            setSelectedDispatch(prev => { const next = new Map(prev); next.set(dispatchKey(popupAgent), idx); return next })
            if (selected) setPopupSubject({ agentName: popupAgent.name, dispatchId: selected.id })
            const convId = selected?.conversationId
            if (convId) loadSingleConversation(convId).catch((err) => rError('agent-panel', 'popup select dispatch load conversation failed', { conversation_id: convId, error: String(err) }))
          }}
          onClose={() => setPopupSubject(null)}
          dispatchTelemetry={dispatchTelemetry}
          allAgents={agents}
        />
      )}
    </div>
  )
}
