import React from 'react'
import { X } from '@phosphor-icons/react'
import { InboxSidebar } from '../studio/inbox/InboxSidebar'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { usePanelVerticalResize } from '../hooks/usePanelVerticalResize'

/** Shared Inbox content inside Overlay's left floating-panel shell. */
export function InboxPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const colors = useColors()
  const expandedUI = usePreferencesStore((state) => state.expandedUI)
  const { height, renderHandle } = usePanelVerticalResize({
    panelId: 'inbox-panel',
    expandedUI,
    // Inbox and Explorer are mutually exclusive forms of the same left rail,
    // so they share one persisted height rather than drift separately.
    override: usePreferencesStore((state) => state.fileExplorerHeight),
    onCommit: usePreferencesStore((state) => state.setFileExplorerHeight),
  })

  return (
    <div
      data-ion-ui
      className="glass-surface"
      style={{
        width: '100%',
        height,
        display: 'flex',
        flexDirection: 'column',
        background: colors.containerBg,
        border: `1px solid ${colors.containerBorder}`,
        borderRadius: 16,
        boxShadow: colors.cardShadow,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {renderHandle()}
      <div style={{ display: 'flex', alignItems: 'center', padding: '6px 10px', background: colors.surfacePrimary, borderBottom: `1px solid ${colors.containerBorder}` }}>
        <button onClick={onClose} aria-label="Close inbox" style={{ border: 'none', background: 'transparent', color: colors.textTertiary, cursor: 'pointer', display: 'flex', padding: 1 }}>
          <X size={11} />
        </button>
        <span style={{ marginLeft: 5, fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', color: colors.textTertiary }}>INBOX</span>
      </div>
      <InboxSidebar />
    </div>
  )
}
