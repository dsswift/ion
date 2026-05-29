import React, { useState, useEffect, useRef, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CaretRight, SpinnerGap, ArrowsOutSimple, ArrowsInSimple, ArrowCircleRight } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { groupMessages, ToolGroup, AssistantMessage, MessageBubble } from './conversation'
import { meta, isAgentVisible, sortAgents, getLabelBg, getStatusSuffix, formatDuration } from './agent-panel-helpers'
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
}

function AgentExpandedView({ agent, colors, loadedMessages, loading, isFullscreen }: ExpandedViewProps) {
  const agentModel = meta<string>(agent, 'model', '')
  const startTime = agent.metadata?.startTime as number | undefined
  const elapsed = agent.metadata?.elapsed as number | undefined
  const showInfoBar = agentModel || startTime != null || elapsed != null
  const dispatchTask = meta<string>(agent, 'task', '')

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
          Duration: <DurationDisplay startTime={startTime} elapsed={elapsed} status={agent.status} />
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

  if (loading) {
    return (
      <div style={{ background: 'rgba(255,255,255,0.03)' }}>
        {infoBar}
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
  const [agentConversations, setAgentConversations] = useState<Map<string, Message[]>>(new Map())
  const [agentLoading, setAgentLoading] = useState<Map<string, boolean>>(new Map())
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

  const loadConversation = useCallback(async (agent: AgentStateUpdate) => {
    // Support both single conversationId and accumulated conversationIds array.
    // Use Array.isArray + String() coercion instead of bare `as string[]` cast
    // to guard against Go []interface{} → JSON round-trip type mismatches.
    const rawConvIds = agent.metadata?.conversationIds
    const convIds = Array.isArray(rawConvIds) ? rawConvIds.map(String) : undefined
    const singleId = agent.metadata?.conversationId
    const ids = convIds && convIds.length > 0 ? convIds : (typeof singleId === 'string' && singleId) ? [singleId] : []
    console.log(`[AgentPanel] loadConversation: name=${agent.name} convIds=${JSON.stringify(convIds)} singleId=${singleId} ids=${JSON.stringify(ids)} rawConvIdsType=${typeof rawConvIds} rawConvIdsIsArray=${Array.isArray(rawConvIds)}`)
    if (ids.length === 0) {
      if (agent.metadata?.task) {
        console.warn(`[AgentPanel] loadConversation: agent=${agent.name} has task but no conversationId — metadata keys: ${Object.keys(agent.metadata || {}).join(',')}`)
      }
      return
    }
    // Use the stringified IDs as a cache key so we re-fetch when new dispatches add IDs
    const cacheKey = ids.join(',')
    const cached = agentConversations.get(agent.name)
    if (cached && (cached as any).__cacheKey === cacheKey) return

    setAgentLoading(prev => { const next = new Map(prev); next.set(agent.name, true); return next })
    try {
      const allMsgs: Message[] = []
      for (const convId of ids) {
        console.log(`[AgentPanel] fetching conversation: convId=${convId}`)
        const data = await window.ion.getConversation(convId, 0, 200)
        const msgs: Message[] = (data.messages || []).map((m: any, i: number) => ({
          id: `${agent.name}-${convId.slice(0, 8)}-${i}`,
          role: m.role,
          content: m.content,
          toolName: m.toolName || '',
          toolInput: m.toolInput || '',
          toolStatus: 'completed' as const,
          timestamp: m.timestamp || 0,
        }))
        allMsgs.push(...msgs)
      }
      console.log(`[AgentPanel] loaded ${allMsgs.length} messages for ${agent.name}`)
      // Attach cache key so we can detect when new conversation IDs arrive
      ;(allMsgs as any).__cacheKey = cacheKey
      setAgentConversations(prev => { const next = new Map(prev); next.set(agent.name, allMsgs); return next })
    } catch (err) {
      console.error(`[AgentPanel] loadConversation error:`, err)
    } finally {
      setAgentLoading(prev => { const next = new Map(prev); next.set(agent.name, false); return next })
    }
  }, [agentConversations])

  // Re-fetch conversation when an expanded agent transitions to a terminal state
  // or when its conversationIds change (new dispatch completed). This handles
  // the case where a user expands a running agent (no conversationId yet), then
  // the agent completes — and also re-fetches when a second dispatch adds a new
  // conversation ID to the accumulated list.
  useEffect(() => {
    for (const agent of visible) {
      const isExpanded = agentExpanded.get(agent.name)
      const isTerminal = agent.status === 'done' || agent.status === 'error'
      const hasAnyConvId = agent.metadata?.conversationId || (agent.metadata?.conversationIds as any[])?.length > 0
      if (isExpanded && isTerminal && hasAnyConvId) {
        loadConversation(agent)
      }
    }
  }, [visible, agentExpanded, loadConversation])

  const toggleAgent = (name: string, agent: AgentStateUpdate) => {
    const willExpand = !agentExpanded.get(name)
    setAgentExpanded((prev) => {
      const next = new Map(prev)
      next.set(name, willExpand)
      return next
    })
    if (willExpand) {
      loadConversation(agent)
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
                          loadedMessages={agentConversations.get(agent.name)}
                          loading={agentLoading.get(agent.name)}
                          isFullscreen={isFullscreen}
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
