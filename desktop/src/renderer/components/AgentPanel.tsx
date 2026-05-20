import React, { useState, useEffect, useRef, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CaretRight, SpinnerGap, ArrowsOutSimple, ArrowsInSimple } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { groupMessages, ToolGroup, AssistantMessage } from './conversation'
import type { AgentStateUpdate } from '../../shared/types'
import type { Message } from '../../shared/types'

/** Read a metadata field with fallback */
function meta<T>(agent: AgentStateUpdate, key: string, fallback: T): T {
  const val = agent.metadata?.[key]
  return val != null ? (val as T) : fallback
}

const AGENT_COLORS: Record<string, string> = {
  'cloud-architect': '#b4325a',
  'security-officer': '#c88c1e',
  'chief-admin': '#b43232',
  'reliability-engineer': '#32b464',
  'infra-engineer': '#3c96d2',
  'dev-lead': '#8c5ac8',
  'press-secretary': '#8c3cb4',
  'secret-service': '#505050',
  'chief': '#1e3278',
  'specialist': '#144b55',
  'staff': '#411e64',
  'consultant': '#5a410f',
}

function hashColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash) + str.charCodeAt(i)
  const h = Math.abs(hash) % 360
  return `hsl(${h}, 45%, 35%)`
}

function getAgentColor(agent: AgentStateUpdate): string {
  const color = meta(agent, 'color', '')
  if (color) return color
  if (AGENT_COLORS[agent.name]) return AGENT_COLORS[agent.name]
  return hashColor(meta(agent, 'type', agent.name))
}

function isAgentVisible(agent: AgentStateUpdate): boolean {
  const visibility = meta<string>(agent, 'visibility', 'ephemeral')
  switch (visibility) {
    case 'always': return true
    case 'sticky': return meta(agent, 'invited', false)
    case 'ephemeral': return agent.status === 'running'
    default: return agent.status === 'running'
  }
}

function sortAgents(agents: AgentStateUpdate[]): AgentStateUpdate[] {
  const statusOrder: Record<string, number> = { running: 0, done: 1, error: 1, cancelled: 1, idle: 2 }
  const visOrder: Record<string, number> = { always: 0, sticky: 1, ephemeral: 2 }
  return [...agents].sort((a, b) => {
    const sa = statusOrder[a.status] ?? 2
    const sb = statusOrder[b.status] ?? 2
    if (sa !== sb) return sa - sb
    const va = visOrder[meta(a, 'visibility', 'ephemeral')] ?? 9
    const vb = visOrder[meta(b, 'visibility', 'ephemeral')] ?? 9
    if (va !== vb) return va - vb
    return meta(a, 'displayName', a.name).localeCompare(meta(b, 'displayName', b.name))
  })
}

function getLabelBg(agent: AgentStateUpdate): string {
  const base = getAgentColor(agent)
  if (agent.status === 'done') return '#143e1e'
  if (agent.status === 'error') return '#781414'
  return base
}

function getStatusSuffix(agent: AgentStateUpdate): string {
  if (agent.status === 'running') return 'responding...'
  const elapsed = agent.metadata?.elapsed as number | undefined
  if (agent.status === 'done' && elapsed != null) return `done ${elapsed}s`
  if (agent.status === 'done') return 'done'
  if (agent.status === 'error') return 'error'
  return ''
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`
  if (secs < 3600) {
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${m}m ${s}s`
  }
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return `${h}h ${m}m`
}

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

  if (loading) {
    return (
      <div style={{ background: 'rgba(255,255,255,0.03)' }}>
        {infoBar}
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
    const grouped = groupMessages(msgs, { includeUser: false })

    return (
      <div style={{ background: 'rgba(255,255,255,0.03)' }}>
        {infoBar}
        <div
          style={{
            maxHeight: isFullscreen ? undefined : 120,
            overflowY: 'auto',
            padding: '8px 12px 8px 148px',
          }}
        >
          {grouped.map((item, idx) => {
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
      <div
        style={{
          padding: '8px 12px 8px 148px',
          fontSize: 11,
          color: colors.textTertiary,
        }}
      >
        No conversation data available
      </div>
    </div>
  )
}

interface Props {
  agents: AgentStateUpdate[]
  isFullscreen?: boolean
  onToggleFullscreen?: () => void
}

export function AgentPanel({ agents, isFullscreen, onToggleFullscreen }: Props) {
  const colors = useColors()
  const [agentExpanded, setAgentExpanded] = useState<Map<string, boolean>>(new Map())
  const [panelCollapsed, setPanelCollapsed] = useState(true)
  const [agentConversations, setAgentConversations] = useState<Map<string, Message[]>>(new Map())
  const [agentLoading, setAgentLoading] = useState<Map<string, boolean>>(new Map())
  const prevVisibleCount = useRef(0)

  const visible = sortAgents(agents.filter(isAgentVisible))

  // Auto-expand panel when first agent becomes visible
  useEffect(() => {
    if (prevVisibleCount.current === 0 && visible.length > 0) {
      setPanelCollapsed(false)
    }
    prevVisibleCount.current = visible.length
  }, [visible.length])

  const loadConversation = useCallback(async (agent: AgentStateUpdate) => {
    const convId = agent.metadata?.conversationId as string | undefined
    if (!convId) return
    if (agentConversations.has(agent.name)) return

    setAgentLoading(prev => { const next = new Map(prev); next.set(agent.name, true); return next })
    try {
      const data = await window.ion.getConversation(convId, 0, 200)
      const msgs: Message[] = (data.messages || []).map((m: any, i: number) => ({
        id: `${agent.name}-conv-${i}`,
        role: m.role,
        content: m.content,
        toolName: m.toolName || '',
        toolInput: m.toolInput || '',
        toolStatus: 'completed' as const,
        timestamp: m.timestamp || 0,
      }))
      setAgentConversations(prev => { const next = new Map(prev); next.set(agent.name, msgs); return next })
    } catch {
      // Silently fail -- expanded view will show fallback
    } finally {
      setAgentLoading(prev => { const next = new Map(prev); next.set(agent.name, false); return next })
    }
  }, [agentConversations])

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

  // All hooks above — safe to return early now
  if (agents.length === 0) return null

  const running = visible.filter(a => a.status === 'running').length

  return (
    <div
      data-ion-ui
      style={{
        borderTop: `1px solid ${colors.containerBorder}`,
        flexShrink: 0,
      }}
    >
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
            style={{ overflow: 'hidden', maxHeight: isFullscreen ? undefined : 132, overflowY: 'auto' }}
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
