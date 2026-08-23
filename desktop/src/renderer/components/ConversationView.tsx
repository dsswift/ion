import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { useColors } from '../theme'
import { EngineDialog } from './EngineDialog'
import { EngineNotificationToasts } from './EngineNotificationToasts'
import { AgentPanel } from './AgentPanel'
import { PermissionDeniedCard } from './PermissionDeniedCard'
import { resolvePlanCardSuppression } from '../../shared/plan-card-gate'
import { useClearPermissionDenied } from '../hooks/useClearPermissionDenied'
import { ElicitationCardHost } from './ElicitationCardHost'
import { TodoListPanel } from './TodoListPanel'
import { ConversationSearch } from './ConversationSearch'
import { useConversationSearch } from '../hooks/useConversationSearch'
import { useScrollFollow } from './conversation/useScrollFollow'
import { ScrollToBottomButton } from './conversation/ScrollToBottomButton'
import { TranscriptRows } from './conversation/TranscriptRows'
import { TimelineMinimap } from './conversation/TimelineMinimap'
import { deriveTimelineMinimapItems } from './conversation/TimelineMinimap.logic'
import { rDebug, rInfo, rError } from '../rendererLogger'
import {
  groupMessages, suppressUserImageEchoes,
  MessageActions, InterruptButton,
  QueuedMessage, EmptyState, RunDurationFooter,
} from './conversation'

// Stable empty refs to avoid creating new array/object references on every render.
// Without these, `|| []` in selectors creates a new array each time, which Zustand
// treats as a change (Object.is), triggering cascading re-renders.
const EMPTY_ARRAY: any[] = []
const EMPTY_NOTIFICATIONS: any[] = []
const EMPTY_MESSAGES: any[] = []
const EMPTY_AGENTS: any[] = []
const EMPTY_TELEMETRY: import('../../shared/types-engine').DispatchTelemetryEntry[] = []
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
  const tabGroupPinned = useSessionStore(s => s.tabs.find(t => t.id === tabId)?.groupPinned)
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
  const activityOverlayVisible = isRunning || hasRunningChildren || hasBackgroundTasks
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
  const { scrollRef, contentRef, isNearBottomRef: _isNearBottomRef, showScrollBtn, handleScroll, scrollToBottom } = useScrollFollow([
    messages.length, agentStates.length, isRunning,
  ])
  const virtualMessageJumpRef = useRef<((messageId: string) => boolean) | null>(null)

  // Conversation search, scoped to scrollRef.
  const searchTrigger = `${messages.length}:${messages[messages.length - 1]?.content?.length ?? 0}`
  const [searchState, searchActions] = useConversationSearch(scrollRef, searchTrigger)

  // Close search when switching tabs.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('ion:search-close'))
  }, [tabId])

  const handleRetry = useCallback(() => {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
    if (lastUserMsg) submit(tabId, lastUserMsg.content)
  }, [messages, submit, tabId])

  // Full history renders — no pagination. Rows are memoized in
  // TranscriptRows, so a streaming chunk re-renders only the affected row;
  // the rest of the transcript (and its markdown parses) are skipped.
  const visibleMessages = useMemo(() => suppressUserImageEchoes(messages), [messages])
  const grouped = useMemo(() => groupMessages(visibleMessages, { includeUser: true, unifiedTurnView }), [visibleMessages, unifiedTurnView])
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(visibleMessages), [visibleMessages])

  const isThinking = isRunning && messages.some(
    (message) => message.role === 'thinking' && message.thinkingActive,
  )
  const orchestratorActivityLabel = workingMessage || (isThinking ? 'Thinking…' : 'Running…')
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
    submit(tabId, answer)
  }, [tabId, clearPermissionDenied, submit])

  const handleDismissDenial = useCallback(() => {
    dismissPermissionDenied(tabId)
  }, [dismissPermissionDenied, tabId])

  // One pipeline for every surface: implementPlan is a store action, so in
  // the overlay it executes here (the owner) and in the Studio mirror the same
  // click forwards to the owner — the component never runs the business
  // logic itself (unpin ordering, mode flip, group move all happen in one
  // window against one store).
  const handleImplement = useCallback((clearContext: boolean = false) => {
    void useSessionStore.getState().implementPlan(tabId, { clearContext })
      .catch((err) => rError('conversation', 'implement failed', { tab_id: tabId.slice(0, 8), error: String(err) }))
  }, [tabId])

  const handleImplementAndUnpin = useCallback((clearContext: boolean = false) => {
    rInfo('conversation', 'implement-and-unpin', { tab_id: tabId.slice(0, 8), clear_context: clearContext })
    void useSessionStore.getState().implementPlan(tabId, { clearContext, unpin: true })
      .catch((err) => rError('conversation', 'implement-and-unpin failed', { tab_id: tabId.slice(0, 8), error: String(err) }))
  }, [tabId])

  // Per-message actions renderer (rewind/fork menu on user bubbles).
  const renderActions = useCallback((msg: import('../../shared/types-session').Message) => (
    <MessageActions message={msg} variant="user" engineContext={{ tabId, instanceId: activeInstanceId }} />
  ), [tabId, activeInstanceId])

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
        <ConversationSearch
          state={searchState}
          actions={searchActions}
        />
        {/* Dedicated timeline gutter — reserved layout space, so the
            transcript can never render underneath the history rail. */}
        <TimelineMinimap items={minimapItems} scrollRef={scrollRef} virtualMessageJumpRef={virtualMessageJumpRef} />
        <div
          ref={scrollRef}
          data-testid="conversation-transcript"
          onScroll={handleScroll}
          style={{
            flex: 1, minWidth: 0, height: '100%', overflowY: 'auto',
            padding: `8px 12px ${activityOverlayVisible ? CONVERSATION_ACTIVITY_OVERLAY_HEIGHT + 8 : 8}px 4px`,
          }}
        >
          <div ref={contentRef}>
            {messages.length === 0 && !isRunning && <EmptyState />}

            {/* Grouped conversation messages via shared TranscriptRows */}
            <TranscriptRows grouped={grouped} actions={renderActions} scrollRef={scrollRef} forceFullRender={searchState.active} tabId={tabId} activeBackgroundTasks={activeBackgroundTasks} virtualMessageJumpRef={virtualMessageJumpRef} />

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
                {isRunning ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: colors.textTertiary }}>
                    <span
                      className="animate-pulse-dot"
                      style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: colors.statusRunning, display: 'inline-block',
                      }}
                    />
                    <span data-testid="conversation-activity-indicator">{orchestratorActivityWithShells}</span>
                  </div>
                ) : <span />}
                <div data-testid="conversation-interrupt-row" style={{ pointerEvents: 'auto' }}>
                  <InterruptButton onInterrupt={handleAbort} onStopAll={handleStopAll} isRunning={isRunning} runningChildCount={runningChildCount} backgroundTaskCount={backgroundTaskCount} />
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
            tabGroupPinned={tabGroupPinned}
            onDismiss={handleDismissDenial}
            onAnswer={handleAnswerDenial}
            onImplement={handleImplement}
            onImplementAndUnpin={handleImplementAndUnpin}
          />
        )}
      </AnimatePresence>

      <ElicitationCardHost tabId={tabId} />

      {/* Agent panel */}
      <div style={{ flex: agentPanelFullscreen ? 1 : undefined, overflow: agentPanelFullscreen ? 'auto' : undefined, minHeight: 0 }}>
        <AgentPanel
          agents={agentStates}
          dispatchTelemetry={dispatchTelemetry}
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
