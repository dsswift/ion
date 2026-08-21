/**
 * DispatchSplitPane — the Studio center's inline dispatch preview: the
 * SAME AgentDetailBody the overlay's floating popup renders, hosted as a
 * vertical split beside the conversation.
 *
 * Completed or disappeared subjects remain visible only while their owning
 * conversation stays active. Changing conversation closes the split before
 * another conversation's state can render beneath it.
 */
import React from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { activeInstance } from '../stores/conversation-instance'
import { AgentDetailBody } from '../components/AgentDetailBody'
import { useDispatchTranscript, resolveSubjectAgent } from '../hooks/useDispatchTranscript'
import { activeDispatchSplit } from './dispatch-split-state'
import { meta } from '../components/agent-panel-helpers'
import { useColors } from '../theme'
import type { AgentStateUpdate } from '../../shared/types'

export function DispatchSplitPane(): React.JSX.Element | null {
  const colors = useColors()
  const subject = useSessionStore((s) => activeDispatchSplit(s.dispatchSplit, s.activeTabId))
  const closeDispatchSplit = useSessionStore((s) => s.closeDispatchSplit)
  const agentStates = useSessionStore((s) => {
    const inst = activeInstance(s.conversationPanes, s.activeTabId)
    return inst?.agentStates ?? EMPTY_AGENTS
  })
  const dispatchTelemetry = useSessionStore((s) => {
    const inst = activeInstance(s.conversationPanes, s.activeTabId)
    return inst?.dispatchTelemetry
  })

  const liveAgent = resolveSubjectAgent(agentStates, subject)
  // D8 no-auto-close: keep the last resolved agent so a completed/vanished
  // dispatch still renders (with an ended banner) until the user closes.
  const lastAgentRef = React.useRef<AgentStateUpdate | null>(null)
  if (liveAgent) lastAgentRef.current = liveAgent
  const agent = liveAgent ?? lastAgentRef.current

  const transcript = useDispatchTranscript(subject, liveAgent)

  if (!subject) return null

  const data = agent ? transcript.resolveDispatchData(agent, subject.dispatchId) : null
  const ended = agent != null && liveAgent == null
  const title = agent ? meta(agent, 'displayName', agent.name) : subject.agentName

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: `1px solid ${colors.containerBorder}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          borderBottom: `1px solid ${colors.containerBorder}`,
          fontSize: 11,
          fontFamily: 'system-ui, sans-serif',
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 600, color: colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </span>
        {agent?.status === 'done' && <span style={{ color: colors.statusComplete, fontSize: 10 }}>completed</span>}
        {agent?.status === 'error' && <span style={{ color: colors.dangerFg, fontSize: 10 }}>error</span>}
        {ended && <span style={{ color: colors.textTertiary, fontSize: 10 }}>ended</span>}
        <button
          onClick={closeDispatchSplit}
          style={{
            marginLeft: 'auto',
            border: 'none',
            background: 'transparent',
            color: colors.textTertiary,
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
          }}
          aria-label="Close dispatch preview"
        >
          ×
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {agent && data ? (
          <AgentDetailBody
            agent={agent}
            loadedMessages={data.slicedMsgs}
            loading={data.isLoading}
            dispatches={data.dispatches}
            selectedDispatch={data.dispIdx}
            onSelectDispatch={(idx) => {
              const selected = data.dispatches[idx]
              if (selected) useSessionStore.getState().openDispatchSplit({ agentName: agent.name, dispatchId: selected.id })
              if (selected?.conversationId) void transcript.loadSingleConversation(selected.conversationId)
            }}
            dispatchTelemetry={dispatchTelemetry}
            allAgents={agentStates.length > 0 ? agentStates : agent ? [agent] : []}
            hideRootBreadcrumb
          />
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textTertiary, fontSize: 12, fontFamily: 'system-ui, sans-serif' }}>
            Dispatch no longer available.
          </div>
        )}
      </div>
    </div>
  )
}

const EMPTY_AGENTS: AgentStateUpdate[] = []
