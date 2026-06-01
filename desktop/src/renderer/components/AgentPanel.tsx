import React, { useState, useEffect, useRef, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CaretRight, SpinnerGap, ArrowsOutSimple, ArrowsInSimple, ArrowCircleRight } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { groupMessages, ToolGroup, AssistantMessage, MessageBubble } from './conversation'
import { meta, isAgentVisible, sortAgents, getLabelBg, getStatusSuffix, formatDuration, getDispatches, sliceMessagesForDispatch } from './agent-panel-helpers'
import { DispatchPager } from './DispatchPager'
import type { DispatchInfo } from './agent-panel-helpers'
import type { AgentStateUpdate } from '../../shared/types'
import type { Message } from '../../shared/types'

function DurationDisplay({ startTime, elapsed, status }: { startTime?: number; elapsed?: number; status: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (status !== 'running' || !startTime) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [status, startTime])

  if (status === 'running' && startTime) {
    const secs = Math.floor((now / 1000) - startTime)
    return <span>{formatDuration(Math.max(0, secs))}</span>
  }
  if (elapsed != null) {
    return <span>{formatDuration(Math.round(elapsed))}</span>
  }
  return null
}

// ─── Structured expanded view for agent history ───

interface ExpandedViewProps {
  agent: AgentStateUpdate
  colors: ReturnType<typeof useColors>
  loadedMessages?: Message[]
  loading?: boolean
  isFullscreen?: boolean
  dispatches: DispatchInfo[]
  selectedDispatch: number
  onSelectDispatch: (index: number) => void
}

function AgentExpandedView({ agent, colors, loadedMessages, loading, isFullscreen, dispatches, selectedDispatch, onSelectDispatch }: ExpandedViewProps) {
  const hasMultipleDispatches = dispatches.length > 1
  // When pager is active, show the selected dispatch's info instead of top-level
  const activeDispatch = hasMultipleDispatches ? dispatches[selectedDispatch] : undefined
  const agentModel = activeDispatch?.model || meta<string>(agent, 'model', '')
  const startTime = activeDispatch?.startTime ?? (agent.metadata?.startTime as number | undefined)
  const elapsed = activeDispatch?.elapsed ?? (agent.metadata?.elapsed as number | undefined)
  const activeStatus = activeDispatch?.status || agent.status
  const showInfoBar = !hasMultipleDispatches && (agentModel || startTime != null || elapsed != null)
  const dispatchTask = activeDispatch?.task || meta<string>(agent, 'task', '')

  const infoBar = showInfoBar ? (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 12px 4px 148px',
        background: 'rgba(255,255,255,0.03)',
        fontSize: 10,
        color: colors.textTertiary,
        borderBottom: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      {agentModel && <span>Model: {agentModel}</span>}
      {agentModel && (startTime != null || elapsed != null) && <span style={{ opacity: 0.4 }}>|</span>}
      {(startTime != null || elapsed != null) && (
        <span>
          Duration: <DurationDisplay startTime={startTime} elapsed={elapsed} status={activeStatus} />
        </span>
      )}
    </div>
  ) : null

  // Dispatch task bubble — shows the orchestrator's instruction to this agent
  const taskBubble = dispatchTask ? (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 6,
        margin: '6px 12px 4px 148px',
        padding: 8,
        background: 'rgba(255, 165, 0, 0.06)',
        borderRadius: 8,
        border: '1px solid rgba(255, 165, 0, 0.12)',
      }}
    >
      <ArrowCircleRight size={14} weight="fill" style={{ color: 'rgba(255, 165, 0, 0.7)', flexShrink: 0, marginTop: 1 }} />
      <span style={{ fontSize: 11, color: colors.textSecondary, lineHeight: 1.4, wordBreak: 'break-word' }}>
        {dispatchTask}
      </span>
    </div>
  ) : null

  // Dispatch pager — shown when multiple dispatches exist
  const pager = hasMultipleDispatches ? (
    <DispatchPager dispatches={dispatches} selectedIndex={selectedDispatch} onSelect={onSelectDispatch} />
  ) : null

  if (loading) {
    return (
      <div style={{ background: 'rgba(255,255,255,0.03)' }}>
        {infoBar}
        {pager}
        {taskBubble}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 12px 8px 148px',
            fontSize: 11,
            color: colors.textTertiary,
          }}
        >
          <SpinnerGap size={12} style={{ animation: 'spin 1s linear infinite' }} />
          Loading conversation...
        </div>
      </div>
    )
  }

  // Use loaded messages from engine, or fall back to metadata
  const messages = loadedMessages || meta(agent, 'messages', [] as any[])
  if (messages && messages.length > 0) {
    const msgs: Message[] = loadedMessages
      ? loadedMessages
      : (messages as any[]).map((m: any, i: number) => ({
          id: `${agent.name}-msg-${i}`,
          role: m.role as any,
          content: m.content,
          toolName: m.toolName,
          toolInput: '',
          toolStatus: 'completed' as const,
          timestamp: 0,
        }))
    const grouped = groupMessages(msgs, { includeUser: true })

    return (
      <div style={{ background: 'rgba(255,255,255,0.03)' }}>
        {infoBar}
        {pager}
        {taskBubble}
        <div
          style={{
            maxHeight: isFullscreen ? undefined : 200,
            overflowY: 'auto',
            padding: '8px 12px 8px 148px',
          }}
        >
          {grouped.map((item, idx) => {
            if (item.kind === 'user') {
              return <MessageBubble key={item.message.id} message={item.message} skipMotion />
            }
            if (item.kind === 'assistant') {
              return <AssistantMessage key={`a-${idx}`} message={item.message} skipMotion />
            }
            if (item.kind === 'tool-group') {
              return <ToolGroup key={`tg-${idx}`} tools={item.messages} skipMotion />
            }
            return null
          })}
        </div>
      </div>
    )
  }

  // Fallback to raw fullOutput
  const fullOutput = meta(agent, 'fullOutput', '')
  if (fullOutput) {
    return (
      <div style={{ background: 'rgba(255,255,255,0.03)' }}>
        {infoBar}
        {pager}
        {taskBubble}
        <div
          style={{
            maxHeight: isFullscreen ? undefined : 120,
            overflowY: 'auto',
            fontFamily: 'monospace',
            fontSize: 11,
            color: colors.textSecondary,
            padding: '8px 12px 8px 148px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {fullOutput}
        </div>
      </div>
    )
  }

  return (
    <div style={{ background: 'rgba(255,255,255,0.03)' }}>
      {infoBar}
      {pager}
      {taskBubble}
      <div
        style={{
          padding: '8px 12px 8px 148px',
          fontSize: 11,
          color: colors.textTertiary,
        }}
      >
        {agent.status === 'running' ? 'Working...' : 'No conversation data available'}
      </div>
    </div>
  )
}

const DEFAULT_PANEL_HEIGHT = 200
const MIN_PANEL_HEIGHT = 80
const MAX_PANEL_PCT = 0.8

interface Props {
  agents: AgentStateUpdate[]
  isFullscreen?: boolean
  onToggleFullscreen?: () => void
  /** Custom panel height in pixels (rows container). Undefined = default. */
  panelHeight?: number
  /** Called when the user drags the resize handle to a new height. */
  onPanelHeightChange?: (height: number) => void
}

export function AgentPanel({ agents, isFullscreen, onToggleFullscreen, panelHeight, onPanelHeightChange }: Props) {
  const colors = useColors()
  const [agentExpanded, setAgentExpanded] = useState<Map<string, boolean>>(new Map())
  const [panelCollapsed, setPanelCollapsed] = useState(true)
  // Keyed by conversationId — each dispatch's conversation is loaded independently
  const [convMessages, setConvMessages] = useState<Map<string, Message[]>>(new Map())
  const [convLoading, setConvLoading] = useState<Map<string, boolean>>(new Map())
  // Track which dispatch index is selected per agent name
  const [selectedDispatch, setSelectedDispatch] = useState<Map<string, number>>(new Map())
  const prevVisibleCount = useRef(0)
  const panelRef = useRef<HTMLDivElement>(null)

  const visible = sortAgents(agents.filter(isAgentVisible))

  // Auto-expand panel when first agent becomes visible
  useEffect(() => {
    if (prevVisibleCount.current === 0 && visible.length > 0) {
      setPanelCollapsed(false)
    }
    prevVisibleCount.current = visible.length
  }, [visible.length])

  const loadSingleConversation = useCallback(async (convId: string) => {
    if (!convId || convMessages.has(convId)) return
    setConvLoading(prev => { const next = new Map(prev); next.set(convId, true); return next })
    try {
      console.log(`[AgentPanel] fetching conversation: convId=${convId}`)
      const data = await window.ion.getConversation(convId, 0, 200)
      const msgs: Message[] = (data.messages || []).map((m: any, i: number) => ({
        id: `${convId.slice(0, 8)}-${i}`,
        role: m.role,
        content: m.content,
        toolName: m.toolName || '',
        toolInput: m.toolInput || '',
        toolStatus: 'completed' as const,
        timestamp: m.timestamp || 0,
      }))
      console.log(`[AgentPanel] loaded ${msgs.length} messages for convId=${convId}`)
      setConvMessages(prev => { const next = new Map(prev); next.set(convId, msgs); return next })
    } catch (err) {
      console.error(`[AgentPanel] loadConversation error:`, err)
    } finally {
      setConvLoading(prev => { const next = new Map(prev); next.set(convId, false); return next })
    }
  }, [convMessages])

  /** Load the conversation for the selected dispatch of an agent,
   *  then lazily preload the remaining dispatches in the background. */
  const loadAgentDispatch = useCallback((agent: AgentStateUpdate) => {
    const dispatches = getDispatches(agent)
    if (dispatches.length === 0) return
    const idx = selectedDispatch.get(agent.name) ?? dispatches.length - 1
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
      const isExpanded = agentExpanded.get(agent.name)
      const isTerminal = agent.status === 'done' || agent.status === 'error'
      const hasAnyConvId = getDispatches(agent).some(d => d.conversationId)
      if (isExpanded && isTerminal && hasAnyConvId) {
        loadAgentDispatch(agent)
      }
    }
  }, [visible, agentExpanded, loadAgentDispatch])

  /** Check if any conversation is currently loading for an agent. */
  const isAgentLoading = useCallback((agent: AgentStateUpdate): boolean => {
    const dispatches = getDispatches(agent)
    return dispatches.some(d => d.conversationId && convLoading.get(d.conversationId))
  }, [convLoading])

  const toggleAgent = (name: string, agent: AgentStateUpdate) => {
    const isCurrentlyExpanded = agentExpanded.get(name) || false
    // If already expanded and a conversation is loading, ignore the click.
    // This prevents the user from accidentally collapsing the panel and
    // restarting the same slow fetch by clicking impatiently.
    if (isCurrentlyExpanded && isAgentLoading(agent)) return
    const willExpand = !isCurrentlyExpanded
    setAgentExpanded((prev) => {
      const next = new Map(prev)
      next.set(name, willExpand)
      return next
    })
    if (willExpand) {
      // Default to the most recent dispatch (last in array)
      const dispatches = getDispatches(agent)
      if (dispatches.length > 0 && !selectedDispatch.has(name)) {
        setSelectedDispatch(prev => { const next = new Map(prev); next.set(name, dispatches.length - 1); return next })
      }
      loadAgentDispatch(agent)
    }
  }

  // Drag-to-resize handler
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = panelHeight ?? DEFAULT_PANEL_HEIGHT
    const maxHeight = window.innerHeight * MAX_PANEL_PCT

    const onMouseMove = (ev: MouseEvent) => {
      // Dragging up (negative deltaY) should increase panel height
      const deltaY = startY - ev.clientY
      const newHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(maxHeight, startHeight + deltaY))
      onPanelHeightChange?.(Math.round(newHeight))
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [panelHeight, onPanelHeightChange])

  // All hooks above — safe to return early now
  if (agents.length === 0) return null

  const running = visible.filter(a => a.status === 'running').length
  const effectiveHeight = panelHeight ?? DEFAULT_PANEL_HEIGHT

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
        onClick={() => setPanelCollapsed(!panelCollapsed)}
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
        <span>Agents ({visible.length})</span>
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
        {running > 0 && (
          <span style={{ color: colors.accent, fontWeight: 600 }}>{running} active</span>
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
              const isExpanded = agentExpanded.get(agent.name) || false
              const suffix = getStatusSuffix(agent)
              const dispatches = getDispatches(agent)
              const dispIdx = selectedDispatch.get(agent.name) ?? dispatches.length - 1
              const activeConvId = dispatches[dispIdx]?.conversationId || ''
              const rawMsgs = activeConvId ? convMessages.get(activeConvId) : undefined
              // When multiple dispatches share a conversationId (engine reuses
              // the session), slice messages by startTime so each pager tab
              // shows only its own work.
              const activeDispatch = dispatches[dispIdx]
              const sharesConvId = activeDispatch && dispatches.some(d => d.id !== activeDispatch.id && d.conversationId === activeConvId && activeConvId)
              const loadedMsgs = rawMsgs && sharesConvId ? sliceMessagesForDispatch(rawMsgs, activeDispatch, dispatches) : rawMsgs
              const isLoading = activeConvId ? convLoading.get(activeConvId) || false : false

              return (
                <div key={agent.name}>
                  <div
                    data-ion-ui
                    onClick={() => toggleAgent(agent.name, agent)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      height: 22,
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}
                  >
                    {/* Colored label */}
                    <div
                      style={{
                        minWidth: 140,
                        height: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        padding: '0 8px',
                        background: getLabelBg(agent),
                        fontSize: 11,
                        fontWeight: 700,
                        color: '#fff',
                        gap: 6,
                        flexShrink: 0,
                      }}
                    >
                      <span>{meta(agent, 'displayName', agent.name)}</span>
                      {suffix && (
                        <span style={{ fontWeight: 400, opacity: 0.7, fontSize: 10 }}>{suffix}</span>
                      )}
                    </div>

                    {/* Last work text */}
                    <div
                      style={{
                        flex: 1,
                        minWidth: 0,
                        padding: '0 8px',
                        fontSize: 11,
                        color: colors.textTertiary,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {meta(agent, 'lastWork', '')}
                    </div>

                    {/* Expand caret */}
                    <div style={{ padding: '0 6px', display: 'flex', alignItems: 'center', color: colors.textTertiary }}>
                      <CaretRight
                        size={10}
                        style={{
                          transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                          transition: 'transform 0.15s ease',
                        }}
                      />
                    </div>
                  </div>

                  {/* Expanded output */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        style={{ overflow: 'hidden' }}
                      >
                        <AgentExpandedView
                          agent={agent}
                          colors={colors}
                          loadedMessages={loadedMsgs}
                          loading={isLoading}
                          isFullscreen={isFullscreen}
                          dispatches={dispatches}
                          selectedDispatch={dispIdx}
                          onSelectDispatch={(idx) => {
                            setSelectedDispatch(prev => { const next = new Map(prev); next.set(agent.name, idx); return next })
                            const convId = dispatches[idx]?.conversationId
                            if (convId) loadSingleConversation(convId)
                          }}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
