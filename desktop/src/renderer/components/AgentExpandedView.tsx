import React, { useState, useEffect } from 'react'
import { SpinnerGap, ArrowCircleRight } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { groupMessages, ToolGroup, AssistantMessage, MessageBubble, AgentTurnGroup } from './conversation'
import { meta, formatDuration } from './agent-panel-helpers'
import { DispatchPager } from './DispatchPager'
import type { DispatchInfo } from './agent-panel-helpers'
import type { AgentStateUpdate } from '../../shared/types'
import type { Message } from '../../shared/types'

export function DurationDisplay({ startTime, elapsed, status }: { startTime?: number; elapsed?: number; status: string }) {
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

export interface ExpandedViewProps {
  agent: AgentStateUpdate
  colors: ReturnType<typeof useColors>
  loadedMessages?: Message[]
  loading?: boolean
  isFullscreen?: boolean
  dispatches: DispatchInfo[]
  selectedDispatch: number
  onSelectDispatch: (index: number) => void
}

export function AgentExpandedView({ agent, colors, loadedMessages, loading, isFullscreen, dispatches, selectedDispatch, onSelectDispatch }: ExpandedViewProps) {
  // In popup/fullscreen mode, use normal padding; inline mode indents past the agent label
  const leftPad = isFullscreen ? 12 : 148
  const unifiedTurnView = usePreferencesStore((s) => s.unifiedTurnView)
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
        padding: `4px 12px 4px ${leftPad}px`,
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
        margin: `6px 12px 4px ${leftPad}px`,
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
    <DispatchPager dispatches={dispatches} selectedIndex={selectedDispatch} onSelect={onSelectDispatch} compact={isFullscreen} />
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
            padding: `8px 12px 8px ${leftPad}px`,
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
    const grouped = groupMessages(msgs, { includeUser: true, unifiedTurnView })

    return (
      <div style={{ background: 'rgba(255,255,255,0.03)' }}>
        {infoBar}
        {pager}
        {taskBubble}
        <div
          style={{
            maxHeight: isFullscreen ? undefined : 200,
            overflowY: 'auto',
            padding: `8px 12px 8px ${leftPad}px`,
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
            if (item.kind === 'agent-turn') {
              return <AgentTurnGroup key={`at-${idx}`} tools={item.tools} assistantMessages={item.assistantMessages} isActive={item.isActive} skipMotion />
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
            padding: `8px 12px 8px ${leftPad}px`,
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
          padding: `8px 12px 8px ${leftPad}px`,
          fontSize: 11,
          color: colors.textTertiary,
        }}
      >
        {agent.status === 'running' ? 'Working...' : 'No conversation data available'}
      </div>
    </div>
  )
}
