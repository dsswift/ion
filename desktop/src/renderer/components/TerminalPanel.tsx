import React, { useEffect, useRef } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { TerminalInstanceView } from './TerminalInstance'
import { TerminalTabStrip } from './TerminalTabStrip'

// Re-export destroyTerminalInstance for backward compatibility
export { destroyTerminalInstance } from './TerminalInstance'

interface Props {
  tabId: string
  cwd: string
  autoCreate?: boolean
  onEmpty?: () => void
}

export function TerminalPanel({ tabId, cwd, autoCreate = true, onEmpty }: Props) {
  const pane = useSessionStore((s) => s.terminalPanes.get(tabId))
  const hadInstances = useRef(false)

  // Auto-create a default "Shell" instance on first mount if none exist
  useEffect(() => {
    if (!autoCreate) return
    const currentPane = useSessionStore.getState().terminalPanes.get(tabId)
    if (!currentPane || currentPane.instances.length === 0) {
      useSessionStore.getState().addTerminalInstance(tabId, 'user', cwd)
    }
  }, [tabId, cwd, autoCreate])

  useEffect(() => {
    if (pane?.instances.length) {
      hadInstances.current = true
      return
    }
    if (onEmpty && hadInstances.current) onEmpty()
  }, [pane, onEmpty])

  const activeInstance = pane?.instances.find((i) => i.id === pane.activeInstanceId)

  return (
    <div data-ion-ui style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <TerminalTabStrip tabId={tabId} />
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {activeInstance && (
          <TerminalInstanceView
            key={activeInstance.id}
            tabId={tabId}
            instanceId={activeInstance.id}
            cwd={activeInstance.cwd}
            readOnly={activeInstance.readOnly}
          />
        )}
      </div>
    </div>
  )
}
