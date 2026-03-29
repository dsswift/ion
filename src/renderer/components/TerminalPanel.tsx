import React, { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { TerminalInstanceView, destroyTerminalInstance } from './TerminalInstance'
import { TerminalStatusBar } from './TerminalStatusBar'

// Re-export destroyTerminalInstance for backward compatibility
export { destroyTerminalInstance } from './TerminalInstance'

interface Props {
  tabId: string
  cwd: string
}

export function TerminalPanel({ tabId, cwd }: Props) {
  const pane = useSessionStore((s) => s.terminalPanes.get(tabId))

  // Auto-create a default "Shell" instance on first mount if none exist
  useEffect(() => {
    const currentPane = useSessionStore.getState().terminalPanes.get(tabId)
    if (!currentPane || currentPane.instances.length === 0) {
      useSessionStore.getState().addTerminalInstance(tabId, 'user', cwd)
    }
  }, [tabId, cwd])

  const activeInstance = pane?.instances.find((i) => i.id === pane.activeInstanceId)

  return (
    <div data-coda-ui style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <TerminalStatusBar tabId={tabId} />
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
