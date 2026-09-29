import React, { useEffect, useRef } from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { TerminalInstanceView } from './TerminalInstance'
import { TerminalTabStrip } from './TerminalTabStrip'
import { rWarn } from '../rendererLogger'

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

  // Ask the owner for a default shell on first mount. The OWNER decides
  // whether one is needed: this window's copy of the terminal state has not
  // arrived yet when the panel first mounts, so "no shells here" would be a
  // guess, and acting on it added one more shell on every launch.
  useEffect(() => {
    if (!autoCreate) return
    void useSessionStore.getState().ensureTerminalInstance(tabId, cwd).catch((error) => {
      rWarn('terminal', 'automatic conversation terminal creation failed', {
        tab_id: tabId,
        cwd,
        error: String(error),
      })
    })
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
