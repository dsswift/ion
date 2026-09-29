import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { usePreferencesStore } from '../preferences'
import { useColors } from '../theme'
import { EngineDialog } from './EngineDialog'
import { EngineNotificationToasts } from './EngineNotificationToasts'
import { AgentPanel } from './AgentPanel'
import { PermissionDeniedCard } from './PermissionDeniedCard'
import { resolvePlanCardSuppression } from '@ion/shared/plan-card-gate'
import { useClearPermissionDenied } from '../hooks/useClearPermissionDenied'
import { ElicitationCardHost } from './ElicitationCardHost'
import { TodoListPanel } from './TodoListPanel'
import { FindBar } from './FindBar'
import { useDomFind } from '../hooks/useDomFind'
import { usePaneFindEvents } from '../studio/find/pane-find'
import { useScrollFollow } from './conversation/useScrollFollow'
import { ScrollToBottomButton } from './conversation/ScrollToBottomButton'
import { TranscriptRows } from './conversation/TranscriptRows'
import { TimelineMinimap } from './conversation/TimelineMinimap'
import { deriveTimelineMinimapItems } from './conversation/TimelineMinimap.logic'
import { rDebug, rInfo, rWarn, rError } from '../rendererLogger'
import { deriveChartTimelines, type ChartTimeline } from './conversation/chart-revisions'
import {
  groupMessages, suppressUserImageEchoes,
  MessageActions, InterruptButton,
  QueuedMessage, EmptyState, RunDurationFooter,
} from './conversation'
import { host } from '../host/host-instance'
import { usePresenceStore, drivingSubjectFor } from '../stores/presence-store'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { useEnvironmentAvailabilityMap } from '../studio/connection/environment-availability'
import { useTabEnvironmentId } from '../studio/connection/tab-environment'
import { EnvironmentOfflinePanel } from '../studio/connection/EnvironmentUnavailable'
import { submitWithTrace } from '../lib/prompt-trace'

/** The engine conversation a tab is bound to, for a prompt span's attributes. */
function conversationIdOf(tabId: string): string | null | undefined {
  return useSessionStore.getState().tabs.find((t) => t.id === tabId)?.conversationId
}

// Stable empty refs to avoid creating new array/object references on every render.
// Without these, `|| []` in selectors creates a new array each time, which Zustand
// treats as a change (Object.is), triggering cascading re-renders.
const EMPTY_ARRAY: any[] = []
const EMPTY_NOTIFICATIONS: any[] = []
const EMPTY_MESSAGES: any[] = []
const EMPTY_AGENTS: any[] = []
const EMPTY_TELEMETRY: import('@ion/shared/types-engine').DispatchTelemetryEntry[] = []
const CONVERSATION_ACTIVITY_OVERLAY_HEIGHT = 56

// ─── Main Component ───
//
// The single, unified conversation view for EVERY tab, plain or
// extension-backed. There is no separate "engine view": this component (the
// former, richer EngineView) renders every feature from DATA, so engine-only
// chrome (agent panel, dialog, toasts, pinned prompt, working message) simply
// self-hides when its backing collection is empty. A plain conversation that
// dispatches background sub-agents shows the agent panel exactly like an
// extension-backed one. App.tsx mounts this for all non-terminal tabs.

interface ConversationViewProps {
  tabId: string
}

export function ConversationView({ tabId }: ConversationViewProps) {
  const colors = useColors()
  const pane = useSessionStore(s => s.conversationPanes.get(tabId))
  const activeInstanceId = pane?.activeInstanceId || ''
  const key = activeInstanceId ? tabId : ''
  const queuedPrompts = useSessionStore(s => s.tabs.find(t => t.id === tabId)?.queuedPrompts ?? EMPTY_ARRAY)
  const editQueuedMessage = useSessionStore(s => s.editQueuedMessage)

  const pinnedPrompt = useSessionStore(s => {
    const p = s.conversationPanes.get(tabId)
    const k = p?.activeInstanceId ? tabId : ''
    return k ? (s.enginePinnedPrompt.get(k) || '') : ''
  })
  const notifications = useSessionStore(s => {
    const p = s.conversationPanes.get(tabId)
    const k = p?.activeInstanceId ? tabId : ''
    return k ? (s.engineNotifications.get(k) || EMPTY_NOTIFICATIONS) : EMPTY_NOTIFICATIONS
  })
  const messages = useSessionStore(s => {
    const p = s.conversationPanes.get(tabId)
    const inst = p?.activeInstanceId ? p.instances.find(i => i.id === p.activeInstanceId) : null
    return inst?.messages ?? EMPTY_MESSAGES
  })
  const { agentStates, dispatchTelemetry, activeBackgroundTasks } = useSessionStore(useShallow(s => {
    const p = s.conversationPanes.get(tabId)
    const inst = p?.activeInstanceId ? p.instances.find(i => i.id === p.activeInstanceId) : null
    return {
      agentStates: inst?.agentStates ?? EMPTY_AGENTS,
      dispatchTelemetry: inst?.dispatchTelemetry ?? EMPTY_TELEMETRY,
      activeBackgroundTasks: inst?.statusFields?.activeBackgroundTasks ?? EMPTY_ARRAY,
    }
  }))
  const workingMessage = useSessionStore(s => {
    const p = s.conversationPanes.get(tabId)
    const k = p?.activeInstanceId ? tabId : ''
    return k ? (s.engineWorkingMessages.get(k) || '') : ''
  })
  const tabStatus = useSessionStore(s => s.tabs.find(t => t.id === tabId)?.status)
  const lastResult = useSessionStore(s => s.tabs.find(t => t.id === tabId)?.lastResult ?? null)
  // /compact (manual or proactive) never touches tabStatus: the engine
  // dispatches it as a fire-and-forget command, not a chat turn, so it
  // never flips to 'running'. isCompacting is the only signal that a
  // compaction is in flight — without it the transcript goes dark for
  // the full duration and only shows the boundary marker on completion.
  const isCompacting = useSessionStore(s => s.tabs.find(t => t.id === tabId)?.isCompacting ?? false)
  // FR-02 shared-tenancy presence: the subject who started this tab's
  // in-flight run, if it isn't this connection's own subject.
  const presenceDriving = usePresenceStore(s => s.driving)
  const presenceEntries = usePresenceStore(s => s.entries)
  const ownSubject = usePresenceStore(s => s.ownSubject)
  const drivenBySubject = drivingSubjectFor(presenceDriving, ownSubject, tabId)
  const drivenByName = drivenBySubject
    ? (presenceEntries.find(e => e.subject === drivenBySubject)?.displayName ?? drivenBySubject)
    : null
  const permissionDenied = useSessionStore(s => {
    const p = s.conversationPanes.get(tabId)
    const inst = p?.activeInstanceId ? p.instances.find(i => i.id === p.activeInstanceId) : null
    return inst?.permissionDenied ?? null
  })
  const tabPlanFilePath = useSessionStore(s => {
    const p = s.conversationPanes.get(tabId)
    const inst = p?.activeInstanceId ? p.instances.find(i => i.id === p.activeInstanceId) : null
    return inst?.planFilePath ?? null
  })
  const tabConversationId = useSessionStore(s => s.tabs.find(t => t.id === tabId)?.conversationId)
  const staticInfo = useSessionStore(s => s.staticInfo)
  const submit = useSessionStore(s => s.submit)
  const interrupt = useSessionStore(s => s.interrupt)
  const unifiedTurnView = usePreferencesStore(s => s.unifiedTurnView)
  const isRunning = tabStatus === 'running' || tabStatus === 'connecting'
  const runningChildCount = agentStates.filter(a => a.status === 'running').length
  const hasRunningChildren = runningChildCount > 0
  const backgroundTaskCount = activeBackgroundTasks.length
  const hasBackgroundTasks = backgroundTaskCount > 0
  // Compaction has nothing to interrupt via this row (no orchestrator run,
  // no dispatched children, no background shells), so it earns the overlay
  // and the activity label but not the Stop control.
  const showInterrupt = isRunning || hasRunningChildren || hasBackgroundTasks
  const activityOverlayVisible = showInterrupt || isCompacting
  const suppressPlanCard = resolvePlanCardSuppression({
    toolNames: permissionDenied?.tools.map((t) => t.toolName),
    hasRunningChildren,
    tabId,
    runningChildCount,
    log: (msg: string, ...args: any[]) => rDebug('plan-card', msg, ...args),
  })
  const [agentPanelFullscreen, setAgentPanelFullscreen] = useState(false)
  const [agentPanelHeights, setAgentPanelHeights] = useState<Map<string, number>>(new Map())

  // Scroll-follow via shared hook.
  const {
    scrollRef,
    contentRef,
    isNearBottomRef: _isNearBottomRef,
    showScrollBtn,
    handleScroll,
    handleWheel,
    handleTouchStart,
    handleTouchMove,
    handlePointerMove,
    handleKeyDown,
    beginNavigation,
    scrollToBottom,
  } = useScrollFollow([
    messages.length, agentStates.length, isRunning,
  ])
  const virtualMessageJumpRef = useRef<((messageId: string, chartId?: string) => boolean) | null>(null)
  /**
   * Latest derived chart timelines, for resolving a jump's real anchor.
   *
   * A ref rather than a dependency so the subscription below is installed once
   * per tab instead of being torn down and re-added on every message change.
   */
  const chartTimelinesRef = useRef<ChartTimeline[]>([])

  // Find in the transcript, when the conversation pane holds focus.
  const [searchState, searchActions] = useDomFind(scrollRef)
  usePaneFindEvents('conversation', {
    open: searchActions.open,
    next: () => { if (searchState.active) searchActions.next() },
    prev: () => { if (searchState.active) searchActions.prev() },
  })

  // A search belongs to the conversation it was typed in.
  const closeSearch = searchActions.close
  useEffect(() => {
    closeSearch()
  }, [tabId, closeSearch])

  // Chart navigation. The attachments panel and a moved marker both ask main
  // to route a jump; the transcript that owns the target conversation performs
  // it. Following is paused first, or the scroll-follow effect would drag the
  // view straight back to the tail the user just navigated away from.
  useEffect(() => {
    return host.shell.onChartJump(({ tabId: targetTab, chartId, messageId }) => {
      if (targetTab !== tabId) return
      // Take the viewport for this navigation. `pauseFollowing` alone was not
      // enough: the virtualizer's scroll fires handleScroll, and a chart is
      // usually among the NEWEST rows, so the landing position fell inside the
      // tail threshold and tail-following immediately snapped the view back to
      // the bottom. That is why the click appeared to do nothing while the log
      // reported a successful jump.
      beginNavigation()
      // The anchor is resolved from LIVE derivation, not from the id the
      // resource carries. A chart record stores the tool-GATE request id it
      // was minted from, while a transcript row is keyed by the engine's
      // tool-USE id — different id spaces. Jumping on the stored value found
      // no row, so the virtual jump silently no-opped and the transcript
      // never moved. The derived timeline knows the row id that is actually
      // in the DOM; the stored id is only a fallback for a chart the current
      // branch cannot see.
      const timeline = chartTimelinesRef.current.find((t) => t.chartId === chartId)
      const anchorId = timeline?.currentMessageId ?? messageId
      // The chart id goes with the row id: the row locates the TURN, the
      // chart element locates the card inside it. A turn can be several
      // screens tall with the chart at its very end, so row-start alone left
      // the operator looking at the top of the turn.
      if (virtualMessageJumpRef.current?.(anchorId, chartId)) {
        rInfo('conversation.chart', 'jumped to chart (virtual row)', {
          tab_id: tabId.slice(0, 8), chart_id: chartId, anchor_id: anchorId.slice(0, 12),
        })
        return
      }
      const anchorEl = scrollRef.current?.querySelector(`[data-chart-id="${CSS.escape(chartId)}"]`)
      if (anchorEl) {
        // Non-virtual transcript: the card is already mounted, so the browser
        // can place it directly. 'start' matches the virtual path's anchoring
        // rather than centring, so both presentations land the same way.
        anchorEl.scrollIntoView({ block: 'start' })
        rInfo('conversation.chart', 'jumped to chart (mounted row)', {
          tab_id: tabId.slice(0, 8), chart_id: chartId,
        })
        return
      }
      rWarn('conversation.chart', 'chart jump target not found', {
        tab_id: tabId.slice(0, 8), chart_id: chartId, message_id: messageId.slice(0, 12),
      })
    })
  }, [tabId, beginNavigation, scrollRef, chartTimelinesRef])

  const handleRetry = useCallback(() => {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
    if (lastUserMsg) void submitWithTrace(submit, tabId, lastUserMsg.content, conversationIdOf(tabId))
  }, [messages, submit, tabId])

  // Full history renders — no pagination. Rows are memoized in
  // TranscriptRows, so a streaming chunk re-renders only the affected row;
  // the rest of the transcript (and its markdown parses) are skipped.
  const visibleMessages = useMemo(() => suppressUserImageEchoes(messages), [messages])
  // Kept current for the chart-jump handler; the transcript derives its own
  // copy for rendering, and both read the same pure function.
  chartTimelinesRef.current = useMemo(() => deriveChartTimelines(visibleMessages), [visibleMessages])
  const grouped = useMemo(() => groupMessages(visibleMessages, { includeUser: true, unifiedTurnView }), [visibleMessages, unifiedTurnView])
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(visibleMessages), [visibleMessages])

  const isThinking = isRunning && messages.some(
    (message) => message.role === 'thinking' && message.thinkingActive,
  )
  const orchestratorActivityLabel = isCompacting
    ? 'Compacting…'
    : workingMessage || (isThinking ? 'Thinking…' : 'Running…')
  const orchestratorActivityWithShells = backgroundTaskCount > 0
    ? `${orchestratorActivityLabel} · ${backgroundTaskCount} background shell${backgroundTaskCount === 1 ? '' : 's'}`
    : orchestratorActivityLabel

  // Auto-create first instance
  const tabsReady = useSessionStore(s => s.tabsReady)
  useEffect(() => {
    if (!tabsReady) return
    const pane = useSessionStore.getState().conversationPanes.get(tabId)
    if (!pane || pane.instances.length === 0) {
      useSessionStore.getState().addEngineInstance(tabId)
    }
  }, [tabId, tabsReady])

  const dismissNotification = useCallback((id: string) => {
    useSessionStore.setState(state => {
      const p = state.conversationPanes.get(tabId)
      const k = p?.activeInstanceId ? tabId : ''
      if (!k) return {}
      const notifs = new Map(state.engineNotifications)
      const keyNotifs = notifs.get(k) || []
      if (keyNotifs.length === 0) return {}
      notifs.set(k, keyNotifs.filter(n => n.id !== id))
      return { engineNotifications: notifs }
    })
  }, [tabId])

  const handleAbort = useCallback(() => {
    interrupt(tabId, isRunning ? 'orchestrator' : 'all_work')
  }, [interrupt, isRunning, tabId])

  const handleStopAll = useCallback(() => {
    interrupt(tabId, 'all_work')
  }, [interrupt, tabId])

  // Answering clears the card locally and then submits. The submitted prompt
  // is itself what releases the engine's retention (prompt_dispatch.go), so
  // this path needs no explicit resolve — unlike a bare dismissal, which
  // produces no prompt and goes through dismissPermissionDenied below.
  const clearPermissionDenied = useClearPermissionDenied(key, tabId, activeInstanceId)
  const dismissPermissionDenied = useSessionStore(s => s.dismissPermissionDenied)

  const handleAnswerDenial = useCallback((answer: string) => {
    rInfo('conversation', 'handleAnswerDenial', { tab_id: tabId.slice(0, 8), answer_len: answer.length })
    clearPermissionDenied()
    void submitWithTrace(submit, tabId, answer, conversationIdOf(tabId))
  }, [tabId, clearPermissionDenied, submit])

  const handleDismissDenial = useCallback(() => {
    dismissPermissionDenied(tabId)
  }, [dismissPermissionDenied, tabId])

  // One pipeline for every surface: implementPlan is a store action, so in
  // the overlay it executes here (the owner) and in the Studio mirror the same
  // click forwards to the owner — the component never runs the business
  // logic itself (mode flip and divider happen in one window against one
  // store).
  const handleImplement = useCallback((clearContext: boolean = false) => {
    void useSessionStore.getState().implementPlan(tabId, { clearContext })
      .catch((err) => rError('conversation', 'implement failed', { tab_id: tabId.slice(0, 8), error: String(err) }))
  }, [tabId])

  const tabEnvironment = useTabEnvironmentId(tabId)
  const environmentEntry = useEnvironmentAvailabilityMap().get(tabEnvironment)

  // Per-message actions renderer (rewind/fork menu on user bubbles).
  const renderActions = useCallback((msg: import('@ion/shared/types-session').Message) => (
    <MessageActions message={msg} variant="user" engineContext={{ tabId, instanceId: activeInstanceId }} />
  ), [tabId, activeInstanceId])

  // An Environment that has been unreachable past the grace window has had
  // its rows dropped, this conversation's transcript with them. Say so:
  // falling through would render the empty-pane state below, which reads as
  // "nothing here" rather than "this is on a machine you cannot reach".
  if (tabEnvironment !== LOCAL_ENVIRONMENT_ID && environmentEntry?.availability === 'offline') {
    return <EnvironmentOfflinePanel environmentId={tabEnvironment} label={environmentEntry.label} />
  }

  if (!pane || pane.instances.length === 0) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', height: '100%',
        alignItems: 'center', justifyContent: 'center',
        color: colors.textTertiary, fontSize: 13,
      }}>
        Session not started
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      {/* Pinned prompt header */}
      {pinnedPrompt && (
        <div
          style={{
            padding: '8px 12px',
            borderBottom: `1px solid ${colors.containerBorder}`,
            fontSize: 13,
            color: colors.textSecondary,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          <span style={{ color: colors.accent, fontWeight: 600 }}>{' > '}</span>
          {pinnedPrompt}
        </div>
      )}

      {/* Scrollable conversation area (with reserved minimap gutter on the left) */}
      <div style={{ flex: agentPanelFullscreen ? 0 : 1, maxHeight: agentPanelFullscreen ? 100 : undefined, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'row' }}>
        <FindBar
          state={searchState}
          actions={searchActions}
        />
        {/* Dedicated timeline gutter — reserved layout space, so the
            transcript can never render underneath the history rail. */}
        <TimelineMinimap
          items={minimapItems}
          scrollRef={scrollRef}
          virtualMessageJumpRef={virtualMessageJumpRef}
          onNavigate={beginNavigation}
        />
        <div
          ref={scrollRef}
          data-testid="conversation-transcript"
          onWheel={handleWheel}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onPointerMove={handlePointerMove}
          onKeyDown={handleKeyDown}
          onScroll={handleScroll}
          tabIndex={0}
          style={{
            flex: 1, minWidth: 0, height: '100%', overflowY: 'auto',
            padding: `8px 12px ${activityOverlayVisible ? CONVERSATION_ACTIVITY_OVERLAY_HEIGHT + 8 : 8}px 4px`,
          }}
        >
          <div ref={contentRef}>
            {messages.length === 0 && !isRunning && <EmptyState />}

            {/* Grouped conversation messages via shared TranscriptRows */}
            <TranscriptRows grouped={grouped} actions={renderActions} scrollRef={scrollRef} forceFullRender={searchState.active} tabId={tabId} activeBackgroundTasks={activeBackgroundTasks} virtualMessageJumpRef={virtualMessageJumpRef} messages={visibleMessages} />

            {!isRunning && messages.length > 0 && lastResult && (
              <RunDurationFooter durationMs={lastResult.durationMs} reason={lastResult.reason} />
            )}

            {/* Queued prompts */}
            <AnimatePresence>
              {queuedPrompts.map((prompt: string, i: number) => (
                <QueuedMessage key={`queued-${i}`} content={prompt} onEdit={() => editQueuedMessage(tabId)} />
              ))}
            </AnimatePresence>

            {/* Dead / failed state rows */}
            {tabStatus === 'dead' && (
              <div style={{ padding: '6px 0', fontSize: 11, color: colors.statusError }}>
                Session ended unexpectedly
              </div>
            )}
            {tabStatus === 'failed' && (
              <div style={{ padding: '6px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: colors.statusError, fontSize: 11 }}>Failed</span>
                <button
                  onClick={handleRetry}
                  style={{ color: colors.accent, fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        </div>
        {/* Scroll-to-bottom overlays only the transcript. */}
        <ScrollToBottomButton visible={showScrollBtn} onClick={scrollToBottom} />

        {/* Activity stays in the transcript's reading flow. A translucent
            gradient plus backdrop blur makes ending text recede beneath controls
            without splitting the conversation into a separate panel.
            The blur lives on its own static layer (no animating children) —
            an element with backdrop-filter re-samples everything behind it
            on every paint, so an animating child inside it (the pulse dot)
            forced that resample every frame the dot ticked, for as long as
            a message was streaming. The dot animates on a sibling layer on
            top instead, where it can't invalidate the blur. */}
        <AnimatePresence>
          {activityOverlayVisible && (
            <motion.div
              data-testid="conversation-activity-row"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              style={{
                position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 2,
                minHeight: 40,
                pointerEvents: 'none',
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  position: 'absolute', inset: 0,
                  background: `linear-gradient(to bottom, transparent, ${colors.containerBg} 55%)`,
                  backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)',
                }}
              />
              <div
                style={{
                  position: 'relative',
                  padding: '12px 12px 4px',
                  display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
                }}
              >
                {(isRunning || isCompacting) ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: colors.textTertiary }}>
                    <span
                      className="ion-dot-live"
                      style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: isCompacting ? colors.statusCompacting : colors.statusRunning,
                        color: isCompacting ? colors.statusCompacting : colors.statusRunning,
                        display: 'inline-block',
                      }}
                    />
                    <span data-testid="conversation-activity-indicator">{orchestratorActivityWithShells}</span>
                    {drivenByName && (
                      <span data-testid="conversation-driven-by" style={{ color: colors.textTertiary, opacity: 0.8 }}>
                        · driven by {drivenByName}
                      </span>
                    )}
                  </div>
                ) : <span />}
                <div data-testid="conversation-interrupt-row" style={{ pointerEvents: 'auto' }}>
                  {showInterrupt && (
                    <InterruptButton onInterrupt={handleAbort} onStopAll={handleStopAll} isRunning={isRunning} runningChildCount={runningChildCount} backgroundTaskCount={backgroundTaskCount} />
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        </div>
      </div>

      {/* Permission-denied / AskUserQuestion card */}
      <AnimatePresence>
        {permissionDenied && !isRunning && !suppressPlanCard && (
          <PermissionDeniedCard
            tools={permissionDenied.tools}
            tabId={tabId}
            sessionId={tabConversationId ?? null}
            projectPath={staticInfo?.projectPath || ''}
            messages={messages}
            tabPlanFilePath={tabPlanFilePath}
            onDismiss={handleDismissDenial}
            onAnswer={handleAnswerDenial}
            onImplement={handleImplement}
          />
        )}
      </AnimatePresence>

      <ElicitationCardHost tabId={tabId} />

      {/* Agent panel */}
      <div style={{ flex: agentPanelFullscreen ? 1 : undefined, overflow: agentPanelFullscreen ? 'auto' : undefined, minHeight: 0 }}>
        <AgentPanel
          agents={agentStates}
          dispatchTelemetry={dispatchTelemetry}
          tabId={tabId}
          rootOnly
          isFullscreen={agentPanelFullscreen}
          onToggleFullscreen={() => setAgentPanelFullscreen(!agentPanelFullscreen)}
          panelHeight={key ? agentPanelHeights.get(key) : undefined}
          onPanelHeightChange={(h) => {
            if (!key) return
            setAgentPanelHeights(prev => { const next = new Map(prev); next.set(key, h); return next })
          }}
        />
      </div>

      <EngineNotificationToasts notifications={notifications} onDismiss={dismissNotification} />
      <TodoListPanel messages={messages} isRunning={isRunning} />
      <EngineDialog tabId={tabId} />
    </div>
  )
}
