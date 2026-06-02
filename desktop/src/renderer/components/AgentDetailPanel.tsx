import React, { useCallback } from 'react'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { FloatingPanel } from './FloatingPanel'
import { AgentExpandedView } from './AgentExpandedView'
import { meta } from './agent-panel-helpers'
import type { DispatchInfo } from './agent-panel-helpers'
import type { AgentStateUpdate } from '../../shared/types'
import type { Message } from '../../shared/types'

interface AgentDetailPanelProps {
  agent: AgentStateUpdate
  loadedMessages: Message[] | undefined
  loading: boolean
  dispatches: DispatchInfo[]
  selectedDispatch: number
  onSelectDispatch: (idx: number) => void
  onClose: () => void
}

export function AgentDetailPanel({
  agent,
  loadedMessages,
  loading,
  dispatches,
  selectedDispatch,
  onSelectDispatch,
  onClose,
}: AgentDetailPanelProps) {
  const colors = useColors()
  const title = meta(agent, 'displayName', agent.name)
  const geometry = useSessionStore((s) => s.agentDetailGeometry)
  const setGeometry = useSessionStore((s) => s.setAgentDetailGeometry)
  const handleGeometryChange = useCallback(
    (geo: { x: number; y: number; w: number; h: number }) => setGeometry(geo),
    [setGeometry],
  )

  return (
    <FloatingPanel
      title={title}
      onClose={onClose}
      defaultWidth={600}
      defaultHeight={500}
      initialPos={{ x: geometry.x, y: geometry.y }}
      initialSize={{ w: geometry.w, h: geometry.h }}
      onGeometryChange={handleGeometryChange}
    >
      <div style={{ overflow: 'auto', height: '100%' }}>
        <AgentExpandedView
          agent={agent}
          colors={colors}
          loadedMessages={loadedMessages}
          loading={loading}
          isFullscreen={true}
          dispatches={dispatches}
          selectedDispatch={selectedDispatch}
          onSelectDispatch={onSelectDispatch}
        />
      </div>
    </FloatingPanel>
  )
}
