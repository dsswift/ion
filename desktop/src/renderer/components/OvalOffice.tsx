import React, { useState, useMemo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CaretRight } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { groupMessages, ToolGroup, AssistantMessage } from './conversation'
import type { AgentStateUpdate } from '../../shared/types'
import type { Message } from '../../shared/types'

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
  if (agent.color) return agent.color
  if (AGENT_COLORS[agent.name]) return AGENT_COLORS[agent.name]
  return hashColor(agent.type || agent.name)
}

function isAgentVisible(agent: AgentStateUpdate): boolean {
  switch (agent.visibility) {
    case 'always': return true
    case 'sticky': return agent.invited
    case 'ephemeral': return agent.status === 'running'
  }
}

function sortAgents(agents: AgentStateUpdate[]): AgentStateUpdate[] {
  const order: Record<string, number> = { always: 0, sticky: 1, ephemeral: 2 }
  return [...agents].sort((a, b) => {
    const oa = order[a.visibility] ?? 9
    const ob = order[b.visibility] ?? 9
    if (oa !== ob) return oa - ob
    return a.displayName.localeCompare(b.displayName)
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
  if (agent.status === 'done' && agent.elapsed != null) return `done ${agent.elapsed}s`
  if (agent.status === 'done') return 'done'
  if (agent.status === 'error') return 'error'
  return ''
}

// ─── Structured expanded view for agent history ───

function AgentExpandedView({ agent, colors }: { agent: AgentStateUpdate; colors: ReturnType<typeof useColors> }) {
  // Prefer structured messages when available
  if (agent.messages && agent.messages.length > 0) {
    const msgs: Message[] = agent.messages.map((m, i) => ({
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
      {agent.fullOutput}
    </div>
  )
}

interface Props {
  agents: AgentStateUpdate[]
}

export function OvalOffice({ agents }: Props) {
  const colors = useColors()
  const [expanded, setExpanded] = useState<Map<string, boolean>>(new Map())

  const visible = sortAgents(agents.filter(isAgentVisible))
  if (visible.length === 0) return null

  const toggle = (name: string) => {
    setExpanded((prev) => {
      const next = new Map(prev)
      next.set(name, !next.get(name))
      return next
    })
  }

  return (
    <div
      data-ion-ui
      style={{
        maxHeight: 132,
        overflowY: 'auto',
        borderTop: `1px solid ${colors.containerBorder}`,
        flexShrink: 0,
      }}
    >
      {visible.map((agent) => {
        const isExpanded = expanded.get(agent.name) || false
        const suffix = getStatusSuffix(agent)

        return (
          <div key={agent.name}>
            <div
              data-ion-ui
              onClick={() => toggle(agent.name)}
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
                <span>{agent.displayName}</span>
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
                {agent.lastWork || ''}
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
              {isExpanded && (agent.messages?.length || agent.fullOutput) && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  style={{ overflow: 'hidden' }}
                >
                  <AgentExpandedView agent={agent} colors={colors} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )
      })}
    </div>
  )
}
