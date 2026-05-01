import React from 'react'
import { ArrowsOutSimple, ArrowsInSimple } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'

/* ─── Tall View Toggle ─── */

export function TallViewToggle() {
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const isTall = useSessionStore((s) => s.tallViewTabId === s.activeTabId)
  const toggleTallView = useSessionStore((s) => s.toggleTallView)
  const colors = useColors()

  return (
    <button
      onClick={() => toggleTallView(activeTabId)}
      className="flex items-center rounded-full px-1 py-0.5 transition-colors"
      style={{ color: isTall ? colors.accent : colors.textTertiary, cursor: 'pointer' }}
      title={isTall ? 'Exit tall view' : 'Expand to tall view'}
    >
      {isTall ? <ArrowsInSimple size={11} /> : <ArrowsOutSimple size={11} />}
    </button>
  )
}
