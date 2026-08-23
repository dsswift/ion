import React from 'react'
import { useSurfaceStore } from '../surface-store'
import { useSessionStore } from '../../../stores/sessionStore'
import { activeInstance } from '../../../stores/conversation-instance'
import { AgentDetailBody } from '../../../components/AgentDetailBody'
import { meta } from '../../../components/agent-panel-helpers'
import { resolveSubjectAgent, useDispatchTranscript } from '../../../hooks/useDispatchTranscript'
import { useColors } from '../../../theme'
import type { AgentStateUpdate } from '../../../../shared/types'
import type { DispatchTab } from '../../../../shared/studio-surface-types'

const EMPTY_AGENTS: AgentStateUpdate[] = []

/** Render one conversation-owned dispatch preview inside the Studio surface. */
export function DispatchSurface({ tab }: { tab: DispatchTab }): React.JSX.Element {
  const colors = useColors()
  const agentStates = useSessionStore((state) => {
    const instance = activeInstance(state.conversationPanes, state.activeTabId)
    return instance?.agentStates ?? EMPTY_AGENTS
  })
  const dispatchTelemetry = useSessionStore((state) => {
    const instance = activeInstance(state.conversationPanes, state.activeTabId)
    return instance?.dispatchTelemetry
  })
  const activeTabId = useSessionStore((state) => state.activeTabId)
  const subject = React.useMemo(
    () => ({ agentName: tab.agentName, dispatchId: tab.dispatchId }),
    [tab.agentName, tab.dispatchId],
  )
  const liveAgent = resolveSubjectAgent(agentStates, subject)
  const lastAgentRef = React.useRef<AgentStateUpdate | null>(null)
  if (liveAgent) lastAgentRef.current = liveAgent
  const agent = liveAgent ?? lastAgentRef.current
  const transcript = useDispatchTranscript(subject, liveAgent)
  const data = agent ? transcript.resolveDispatchData(agent, tab.dispatchId) : null

  if (!agent || !data) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textTertiary, fontSize: 12, fontFamily: 'system-ui, sans-serif' }}>
        Dispatch no longer available.
      </div>
    )
  }

  return (
    <AgentDetailBody
      agent={agent}
      loadedMessages={data.slicedMsgs}
      loading={data.isLoading}
      dispatches={data.dispatches}
      selectedDispatch={data.dispIdx}
      onSelectDispatch={(index) => {
        const selected = data.dispatches[index]
        if (!selected) return
        useSurfaceStore.getState().openDispatchTab(
          agent.name,
          selected.id,
          meta(agent, 'displayName', agent.name),
        )
        if (selected.conversationId) void transcript.loadSingleConversation(selected.conversationId)
      }}
      dispatchTelemetry={dispatchTelemetry}
      allAgents={agentStates.length > 0 ? agentStates : [agent]}
      hideRootBreadcrumb
      tabId={activeTabId}
    />
  )
}
