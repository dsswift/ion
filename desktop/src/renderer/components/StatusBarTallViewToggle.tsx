import React from 'react'
import { ArrowsOutSimple, ArrowsInSimple } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'

/* ─── Tall View Toggle ─── */

export function TallViewToggle() {
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const isTall = useSessionStore((s) => s.tallViewTabId === s.activeTabId)
  const toggleTallView = useSessionStore((s) => s.toggleTallView)
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()

  return (
    <button
      onClick={() => toggleTallView(activeTabId)}
      {...handlers}
      className="flex items-center rounded-full px-1 py-0.5 ion-focusable"
      style={{
        color: isTall ? colors.accent : hover ? colors.textPrimary : colors.textTertiary,
        background: interactiveBg(colors, { hover, pressed }),
        cursor: 'pointer',
      }}
      title={isTall ? 'Exit tall view' : 'Expand to tall view'}
    >
      {isTall ? <ArrowsInSimple size={11} /> : <ArrowsOutSimple size={11} />}
    </button>
  )
}
