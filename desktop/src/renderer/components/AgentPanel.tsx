import React, { useState, useEffect, useRef, useCallback } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CaretRight, SpinnerGap } from '@phosphor-icons/react'
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
  const visibility = meta(agent, 'visibility', 'ephemeral')
  switch (visibility) {
    case 'always': return true
    case 'sticky': return meta(agent, 'invited', false)
    case 'ephemeral': return agent.status === 'running'
    default: return agent.status === 'running'
  }
}

function sortAgents(agents: AgentStateUpdate[]): AgentStateUpdate[] {
  const order: Record<string, number> = { always: 0, sticky: 1, ephemeral: 2 }
  return [...agents].sort((a, b) => {
    const oa = order[meta(a, 'visibility', 'ephemeral')] ?? 9
    const ob = order[meta(b, 'visibility', 'ephemeral')] ?? 9
    if (oa !== ob) return oa - ob
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

// ─── Structured expanded view for agent history ───

interface ExpandedViewProps {
  agent: AgentStateUpdate
  colors: ReturnType<typeof useColors>
  loadedMessages?: Message[]
  loading?: boolean
}

function AgentExpandedView({ agent, colors, loadedMessages, loading }: ExpandedViewProps) {
  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 12px 8px 148px',
          background: 'rgba(255,255,255,0.03)',
          fontSize: 11,
          color: colors.textTertiary,
        }}
      >
        <SpinnerGap size={12} style={{ animation: 'spin 1s linear infinite' }} />
        Loading conversation...
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
      <div
        style={{
          maxHeight: 120,
          overflowY: 'auto',
          padding: '8px 12px 8px 148px',
          background: 'rgba(255,255,255,0.03)',
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
    )
  }

  // Fallback to raw fullOutput
  const fullOutput = meta(agent, 'fullOutput', '')
  if (fullOutput) {
    return (
      <div
        style={{
          maxHeight: 120,
          overflowY: 'auto',
          fontFamily: 'monospace',
          fontSize: 11,
          color: colors.textSecondary,
          padding: '8px 12px 8px 148px',
          background: 'rgba(255,255,255,0.03)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {fullOutput}
      </div>
    )
  }

  return (
    <div
      style={{
        padding: '8px 12px 8px 148px',
        background: 'rgba(255,255,255,0.03)',
        fontSize: 11,
        color: colors.textTertiary,
      }}
    >
      No conversation data available
    </div>
  )
}

interface Props {
  agents: AgentStateUpdate[]
}

export function AgentPanel({ agents }: Props) {
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
            style={{ overflow: 'hidden', maxHeight: 132, overflowY: 'auto' }}
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
