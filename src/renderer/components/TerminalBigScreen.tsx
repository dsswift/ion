import React from 'react'
import { createPortal } from 'react-dom'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { TerminalInstanceView } from './TerminalInstance'
import { TerminalStatusBar } from './TerminalStatusBar'
import { usePopoverLayer } from './PopoverLayer'

interface Props {
  tabId: string
}

export function TerminalBigScreen({ tabId }: Props) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const pane = useSessionStore((s) => s.terminalPanes.get(tabId))
  const activeInstance = pane?.instances.find((i) => i.id === pane.activeInstanceId)

  if (!popoverLayer) return null

  return createPortal(
    <div
      data-coda-ui
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.6)',
        pointerEvents: 'auto',
      }}
      onClick={(e) => {
        // Click on backdrop exits big screen
        if (e.target === e.currentTarget) {
          useSessionStore.getState().toggleTerminalBigScreen(tabId)
        }
      }}
    >
      <div
        data-coda-ui
        className="glass-surface"
        style={{
          width: '90vw',
          height: '85vh',
          borderRadius: 16,
          background: colors.containerBg,
          border: `1px solid ${colors.containerBorder}`,
          boxShadow: `0 24px 80px rgba(0, 0, 0, 0.5)`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <TerminalStatusBar tabId={tabId} />
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {activeInstance && (
            <TerminalInstanceView
              key={`bigscreen-${activeInstance.id}`}
              tabId={tabId}
              instanceId={activeInstance.id}
              cwd={activeInstance.cwd}
              readOnly={activeInstance.readOnly}
            />
          )}
        </div>
      </div>
    </div>,
    popoverLayer,
  )
}
