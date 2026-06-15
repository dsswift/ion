import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react'
import { AnimatePresence } from 'framer-motion'
import { ArrowCounterClockwise } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { activeInstance } from '../stores/conversation-instance'
import { PermissionCard } from './PermissionCard'
import { PermissionDeniedCard } from './PermissionDeniedCard'
import { useColors } from '../theme'
import { TodoListPanel } from './TodoListPanel'
import { ConversationSearch } from './ConversationSearch'
import { useConversationSearch } from '../hooks/useConversationSearch'
import {
  groupMessages,
  ToolGroup, AssistantMessage, SystemMessage, InterruptButton,
  UserMessage, QueuedMessage, MessageActions, EmptyState,
  CompactionRow, AgentTurnGroup, InterceptBanner,
} from './conversation'
import { buildPermissionDeniedHandlers } from './conversation/usePermissionDeniedHandlers'

// ─── Constants ───

const INITIAL_RENDER_CAP = 100
const PAGE_SIZE = 100

// ─── Main Component ───

export function ConversationView() {
  const tabs = useSessionStore((s) => s.tabs)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const sendMessage = useSessionStore((s) => s.sendMessage)
  const editQueuedMessage = useSessionStore((s) => s.editQueuedMessage)
  const staticInfo = useSessionStore((s) => s.staticInfo)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [, setHovered] = useState(false)
  const [renderOffset, setRenderOffset] = useState(0) // 0 = show from tail
  const isNearBottomRef = useRef(true)
  const prevTabIdRef = useRef(activeTabId)
  const colors = useColors()
  const unifiedTurnView = usePreferencesStore((s) => s.unifiedTurnView)
  const conversationFontSize = usePreferencesStore((s) => s.conversationFontSize)
  const scrollToBottomCounter = useSessionStore((s) => s.scrollToBottomCounter)

  const tab = tabs.find((t) => t.id === activeTabId)

  // Per-conversation state (messages, permission queue/denied, planFilePath)
  // now lives on the active `ConversationInstance` in `conversationPanes`, not on
  // `TabState`. Subscribe to the active instance so the view re-renders as
  // its scrollback/permission state changes. Normal tabs resolve to their
  // single `main` instance; engine tabs to their active sub-conversation.
  const inst = useSessionStore((s) =>
    activeTabId ? activeInstance(s.conversationPanes, activeTabId) : null,
  )

  // Reset render offset and scroll state when switching tabs
  useEffect(() => {
    if (activeTabId !== prevTabIdRef.current) {
      prevTabIdRef.current = activeTabId
      setRenderOffset(0)
      isNearBottomRef.current = true
    }
  }, [activeTabId])

  // Track whether user is scrolled near the bottom
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }, [])

  // Auto-scroll when content changes and user is near bottom.
  const msgCount = inst?.messages?.length ?? 0
  const lastMsg = inst?.messages?.at(-1)
  const permissionQueueLen = inst?.permissionQueue?.length ?? 0
  const queuedCount = tab?.queuedPrompts?.length ?? 0
  const scrollTrigger = `${msgCount}:${lastMsg?.content?.length ?? 0}:${permissionQueueLen}:${queuedCount}`

  useEffect(() => {
    if (isNearBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [scrollTrigger])

  // Force scroll to bottom when user sends a new message (even if scrolled up)
  useEffect(() => {
    if (scrollToBottomCounter > 0 && scrollRef.current) {
      isNearBottomRef.current = true
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [scrollToBottomCounter])

  // Group only the visible slice of messages
  const allMessages = inst?.messages ?? []
  const totalCount = allMessages.length
  let startIndex = Math.max(0, totalCount - INITIAL_RENDER_CAP - renderOffset * PAGE_SIZE)

  // When unified turn view is on, snap startIndex backward to the nearest
  // user message so we never show a partial turn at the top of the visible window.
  if (unifiedTurnView && startIndex > 0) {
    let snapped = startIndex
    while (snapped > 0 && allMessages[snapped]?.role !== 'user') {
      snapped--
    }
    startIndex = snapped
  }

  const visibleMessages = useMemo(() => startIndex > 0 ? allMessages.slice(startIndex) : allMessages, [allMessages, startIndex])
  const hasOlder = startIndex > 0

  const grouped = useMemo(
    () => groupMessages(visibleMessages, { unifiedTurnView }),
    [visibleMessages, unifiedTurnView],
  )

  const hiddenCount = totalCount - visibleMessages.length

  const handleLoadOlder = useCallback(() => {
    setRenderOffset((o) => o + 1)
  }, [])

  // Load all older messages (used by ConversationSearch "Load all" button)
  const handleLoadAllOlder = useCallback(() => {
    setRenderOffset(Math.ceil(totalCount / INITIAL_RENDER_CAP))
  }, [totalCount])

  // Conversation search — scoped to scrollRef
  const [searchState, searchActions] = useConversationSearch(scrollRef, scrollTrigger)

  // When search scrolls to a match, prevent auto-scroll-to-bottom from fighting it
  useEffect(() => {
    const handler = () => { isNearBottomRef.current = false }
    window.addEventListener('ion:search-scrolled', handler)
    return () => window.removeEventListener('ion:search-scrolled', handler)
  }, [])

  // Close search when switching tabs
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('ion:search-close'))
  }, [activeTabId])

  if (!tab) return null

  // Skeleton tab: the active instance hasn't been hydrated yet (lazy loading
  // in progress). Under the 2A invariant a normal tab's `main` instance is
  // materialized eagerly, so a null `inst` here means the pane/instance is
  // not yet present — treat it as the loading state.
  if (!inst) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: colors.textSecondary }}>
        <div className="flex items-center gap-2 text-sm">
          <span className="flex gap-[3px]">
            <span className="w-[4px] h-[4px] rounded-full animate-bounce-dot" style={{ background: colors.statusRunning, animationDelay: '0ms' }} />
            <span className="w-[4px] h-[4px] rounded-full animate-bounce-dot" style={{ background: colors.statusRunning, animationDelay: '150ms' }} />
            <span className="w-[4px] h-[4px] rounded-full animate-bounce-dot" style={{ background: colors.statusRunning, animationDelay: '300ms' }} />
          </span>
          Loading conversation…
        </div>
      </div>
    )
  }

  const isRunning = tab.status === 'running' || tab.status === 'connecting'
  const isDead = tab.status === 'dead'
  const isFailed = tab.status === 'failed'
  const showInterrupt = (isRunning || tab.bashExecuting) && inst.messages.some((m) => m.role === 'user')

  if (inst.messages.length === 0) {
    return <EmptyState />
  }

  // Messages from before initial render cap are "historical" — no motion
  const historicalThreshold = Math.max(0, totalCount - 20)

  const handleRetry = () => {
    const lastUserMsg = [...inst.messages].reverse().find((m) => m.role === 'user')
    if (lastUserMsg) {
      sendMessage(lastUserMsg.content)
    }
  }

  const permissionDeniedHandlers = inst.permissionDenied
    ? buildPermissionDeniedHandlers(tab, sendMessage)
    : null

  return (
    <div
      data-ion-ui
      className="flex flex-col min-h-0 min-w-0 overflow-hidden"
      style={{ flex: 1 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Scroll area wrapper — relative so activity row and search bar can overlay */}
      <div className="relative flex-1 min-h-0 min-w-0 flex flex-col">
        <ConversationSearch
          state={searchState}
          actions={searchActions}
          hiddenCount={hiddenCount}
          onLoadAllOlder={handleLoadAllOlder}
        />
        {/* Scrollable messages area */}
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 pt-2 conversation-selectable"
          style={{ paddingBottom: 28, ['--ion-conv-font-size' as string]: `${conversationFontSize}px` } as React.CSSProperties}
          onScroll={handleScroll}
        >
        {/* Load older button */}
        {hasOlder && (
          <div className="flex justify-center py-2">
            <button
              onClick={handleLoadOlder}
              className="text-[11px] px-3 py-1 rounded-full transition-colors"
              style={{ color: colors.textTertiary, border: `1px solid ${colors.toolBorder}` }}
            >
              Load {Math.min(PAGE_SIZE, hiddenCount)} older messages ({hiddenCount} hidden)
            </button>
          </div>
        )}

        <div className="space-y-1 relative min-w-0">
          {grouped.map((item, idx) => {
            const msgIndex = startIndex + idx
            const isHistorical = msgIndex < historicalThreshold

            switch (item.kind) {
              case 'user':
                return <UserMessage key={item.message.id} message={item.message} skipMotion={isHistorical} />
              case 'assistant':
                return <AssistantMessage key={item.message.id} message={item.message} skipMotion={isHistorical} actions={<MessageActions message={item.message} variant="assistant" />} />
              case 'tool-group':
                return <ToolGroup key={`tg-${item.messages[0].id}`} tools={item.messages} skipMotion={isHistorical} />
              case 'agent-turn':
                return <AgentTurnGroup key={`at-${item.tools[0]?.id ?? idx}`} tools={item.tools} assistantMessages={item.assistantMessages} isActive={item.isActive} skipMotion={isHistorical} />
              case 'compaction':
                return <CompactionRow key={item.message.id} message={item.message} skipMotion={isHistorical} />
              case 'system':
                return <SystemMessage key={item.message.id} message={item.message} skipMotion={isHistorical} />
              case 'intercept':
                return <InterceptBanner key={item.message.id} message={item.message} skipMotion={isHistorical} />
              default:
                return null
            }
          })}
        </div>

        {/* Permission card (shows first item from queue) */}
        <AnimatePresence>
          {inst.permissionQueue.length > 0 && (
            <PermissionCard
              tabId={tab.id}
              permission={inst.permissionQueue[0]}
              queueLength={inst.permissionQueue.length}
            />
          )}
        </AnimatePresence>

        {/* Permission denied fallback card.
            Hidden while the tab is running — after the user sends feedback,
            answers a question, or clicks Implement, the card must stay hidden
            until the agent finishes the new turn. Without this, stale heartbeat
            ticks can re-synthesize task_complete with old permissionDenials
            before prompt_dispatch clears the engine's lastPermissionDenials. */}
        <AnimatePresence>
          {inst.permissionDenied && permissionDeniedHandlers && !isRunning && (
            <PermissionDeniedCard
              tools={inst.permissionDenied.tools}
              tabId={tab.id}
              sessionId={tab.conversationId}
              projectPath={staticInfo?.projectPath || process.cwd()}
              messages={inst.messages}
              tabPlanFilePath={inst.planFilePath}
              tabGroupPinned={tab.groupPinned}
              onDismiss={permissionDeniedHandlers.onDismiss}
              onAnswer={permissionDeniedHandlers.onAnswer}
              onApprove={permissionDeniedHandlers.onApprove}
              onImplement={permissionDeniedHandlers.onImplement}
              onImplementAndUnpin={permissionDeniedHandlers.onImplementAndUnpin}
            />
          )}
        </AnimatePresence>

        {/* Queued prompts */}
        <AnimatePresence>
          {tab.queuedPrompts.map((prompt, i) => (
            <QueuedMessage key={`queued-${i}`} content={prompt} onEdit={() => editQueuedMessage(tab.id)} />
          ))}
        </AnimatePresence>

        <div ref={bottomRef} />
      </div>

        {/* Activity row — absolutely positioned over bottom of scroll area */}
        <div
          className="flex items-center justify-between px-4"
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 28,
            background: `linear-gradient(to bottom, transparent, ${colors.containerBg} 70%)`,
            zIndex: 2,
          }}
        >
        {/* Left: status indicator */}
        <div className="flex items-center gap-1.5 text-[11px] min-w-0">
          {isRunning && (
            <span className="flex items-center gap-1.5">
              <span className="flex gap-[3px]">
                <span className="w-[4px] h-[4px] rounded-full animate-bounce-dot" style={{ background: tab.isCompacting ? colors.statusCompacting : colors.statusRunning, animationDelay: '0ms' }} />
                <span className="w-[4px] h-[4px] rounded-full animate-bounce-dot" style={{ background: tab.isCompacting ? colors.statusCompacting : colors.statusRunning, animationDelay: '150ms' }} />
                <span className="w-[4px] h-[4px] rounded-full animate-bounce-dot" style={{ background: tab.isCompacting ? colors.statusCompacting : colors.statusRunning, animationDelay: '300ms' }} />
              </span>
              <span style={{ color: colors.textSecondary }}>{tab.currentActivity || 'Working...'}</span>
            </span>
          )}

          {isDead && (
            <span style={{ color: colors.statusError, fontSize: 11 }}>Session ended unexpectedly</span>
          )}

          {isFailed && (
            <span className="flex items-center gap-1.5">
              <span style={{ color: colors.statusError, fontSize: 11 }}>Failed</span>
              <button
                onClick={handleRetry}
                className="flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors"
                style={{ color: colors.accent, fontSize: 11 }}
              >
                <ArrowCounterClockwise size={10} />
                Retry
              </button>
            </span>
          )}
        </div>

        {/* Right: interrupt button when running */}
        <div className="flex items-center flex-shrink-0">
          <AnimatePresence>
            {showInterrupt && (
              <InterruptButton onInterrupt={async () => {
                console.log(`[ConversationView] interrupt: tabId=${tab.id} bashExecId=${tab.bashExecId ?? 'none'} status=${tab.status}`)
                if (tab.bashExecId) {
                  console.log(`[ConversationView] cancelling bash: execId=${tab.bashExecId}`)
                  window.ion.cancelBash(tab.bashExecId)
                  return
                }
                console.log(`[ConversationView] stopping tab: tabId=${tab.id}`)
                const tabId = tab.id
                try { await window.ion.stopTab(tabId) } catch {}
                // 5s fallback: if engine never confirms idle, force-recover locally
                // so the UI is always usable after pressing the interrupt button.
                setTimeout(() => {
                  const cur = useSessionStore.getState().tabs.find((t) => t.id === tabId)
                  if (cur && (cur.status === 'running' || cur.status === 'connecting')) {
                    useSessionStore.getState().forceRecoverTab(
                      tabId,
                      'Engine did not respond to interrupt within 5s. Tab reset locally.'
                    )
                  }
                }, 5_000)
              }} />
            )}
          </AnimatePresence>
        </div>
      </div>{/* end activity row */}
      </div>{/* end scroll + activity wrapper */}

      {/* Task list — pinned below scroll area */}
      <TodoListPanel messages={inst.messages} isRunning={isRunning} />
    </div>
  )
}
