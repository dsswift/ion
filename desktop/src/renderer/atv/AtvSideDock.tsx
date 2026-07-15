/**
 * AtvSideDock — the operator's workbench: a resizable right dock beside the
 * office canvas. The Conversation tab hosts the REAL overlay components
 * (ConversationView + InputBar) on the mirror store — parity mechanism 1:
 * shared surfaces are the same component, never a bespoke widget. Files and
 * Attachments tabs join in their own commit.
 *
 * Lazy hydration: mirror panes start as skeletons (empty messages +
 * persisted messageCount). The owner's selectTab lazy-load never runs here
 * (selectTab is forwarded), so the dock triggers loadSkeletonMessages —
 * a mirror-local action backed by the stateless loadSession IPC — the first
 * time a tab's conversation becomes visible.
 */
import React, { useEffect, useRef } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { activeInstance, needsHistoryHydration } from '../stores/conversation-instance'
import { ConversationView } from '../components/ConversationView'
import { InputBar } from '../components/InputBar'
import { FileExplorer } from '../components/FileExplorer'
import { useColors } from '../theme'
import { rDebug } from '../rendererLogger'

const MIN_W = 320
const MAX_W = 720
const DEFAULT_W = 420

export type DockTab = 'conversation' | 'files'

export interface AtvSideDockProps {
  open: boolean
  /** Persisted layout (one global state) — controlled by the shell. */
  width: number
  tab: DockTab
  onLayoutChange(patch: Partial<{ dockWidth: number; dockTab: DockTab }>): void
  onClose(): void
}

export function AtvSideDock(props: AtvSideDockProps): React.JSX.Element | null {
  const colors = useColors()
  const width = Math.min(MAX_W, Math.max(MIN_W, props.width || DEFAULT_W))
  const tab = props.tab
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)
  // Stable-ref so the once-registered pointer listeners see fresh callbacks.
  const layoutChangeRef = useRef(props.onLayoutChange)
  layoutChangeRef.current = props.onLayoutChange
  const activeTabId = useSessionStore((s) => s.activeTabId)
  // needsHistoryHydration, not message emptiness: live events stream into
  // mirror skeleton panes before the user switches to them, and an emptiness
  // check would skip the history load — showing only the last live turn.
  const needsHydration = useSessionStore((s) =>
    needsHistoryHydration(activeInstance(s.conversationPanes, s.activeTabId)),
  )

  // First-visibility hydration per tab (and re-check on tab switch).
  useEffect(() => {
    if (!props.open || !activeTabId || !needsHydration) return
    rDebug('atv.dock', 'hydrating skeleton conversation', { tab_id: activeTabId.slice(0, 8) })
    void useSessionStore.getState().loadSkeletonMessages(activeTabId)
  }, [props.open, activeTabId, needsHydration])

  useEffect(() => {
    function onMove(e: PointerEvent): void {
      const drag = dragRef.current
      if (!drag) return
      layoutChangeRef.current({ dockWidth: Math.min(MAX_W, Math.max(MIN_W, drag.startW + (drag.startX - e.clientX))) })
    }
    function onUp(): void {
      dragRef.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  if (!props.open) return null
  return (
    <div
      style={{
        width,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: `1px solid ${colors.containerBorder}`,
        background: colors.containerBg,
        position: 'relative',
        minHeight: 0,
      }}
    >
      {/* Resize handle. */}
      <div
        onPointerDown={(e) => {
          dragRef.current = { startX: e.clientX, startW: width }
        }}
        style={{ position: 'absolute', left: -3, top: 0, bottom: 0, width: 6, cursor: 'col-resize', zIndex: 2 }}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '4px 10px',
          borderBottom: `1px solid ${colors.containerBorder}`,
          fontFamily: 'system-ui, sans-serif',
          fontSize: 12,
          gap: 8,
        }}
      >
        {(['conversation', 'files'] as const).map((t) => (
          <button
            key={t}
            onClick={() => props.onLayoutChange({ dockTab: t })}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              padding: '2px 4px',
              fontSize: 12,
              fontWeight: tab === t ? 600 : 400,
              color: tab === t ? colors.textPrimary : colors.textTertiary,
              borderBottom: tab === t ? `2px solid ${colors.accent}` : '2px solid transparent',
            }}
          >
            {t === 'conversation' ? 'Conversation' : 'Files'}
          </button>
        ))}
        <button
          onClick={props.onClose}
          style={{
            marginLeft: 'auto',
            border: 'none',
            background: 'transparent',
            color: colors.textTertiary,
            cursor: 'pointer',
            fontSize: 14,
          }}
          aria-label="Close dock"
        >
          ×
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {!activeTabId ? (
          <div style={{ padding: 16, color: colors.textTertiary, fontSize: 12 }}>No active conversation.</div>
        ) : tab === 'conversation' ? (
          <>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <ConversationView tabId={activeTabId} />
            </div>
            {/* Input pill — the same rounded chrome the overlay wraps around
                InputBar (App.tsx). Bare-mounting the component left the text
                and buttons flush against the dock borders with no visual
                "this is the composer" affordance. */}
            <div style={{ flexShrink: 0, padding: '10px 10px 12px', borderTop: `1px solid ${colors.containerBorder}` }}>
              <div style={{ minHeight: 50, borderRadius: 25, padding: '0 6px 0 16px', background: colors.inputPillBg, border: `1px solid ${colors.containerBorder}` }}>
                <InputBar />
              </div>
            </div>
          </>
        ) : (
          // Files: the real explorer, scoped to the active tab's working
          // directory. Opening a file routes through openFileInEditor →
          // the floating FileEditor rendered at the shell level.
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <FileExplorer />
          </div>
        )}
      </div>
    </div>
  )
}
