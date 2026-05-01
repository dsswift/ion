import React, { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { getModelContextWindow } from '../stores/model-labels'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'

/* ─── Context Percentage Indicator ─── */

export function ContextIndicator() {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const preferredModel = usePreferencesStore((s) => s.preferredModel)
  const { contextTokens, contextPercent } = useSessionStore(
    useShallow((s) => {
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      return { contextTokens: tab?.contextTokens ?? null, contextPercent: tab?.contextPercent ?? null }
    }),
  )

  const [hover, setHover] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  const windowSize = getModelContextWindow(preferredModel)

  // Use engine-computed percent when available, otherwise calculate locally
  const pct = contextPercent != null
    ? contextPercent
    : contextTokens != null
      ? Math.round((contextTokens / windowSize) * 100)
      : null

  if (pct === null) return null

  const tokens = contextTokens ?? (pct * windowSize / 100)
  const formatTokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`
  const tooltip = `${formatTokens(tokens)} / ${formatTokens(windowSize)} tokens`

  let color = colors.textTertiary
  if (pct >= 70) color = '#e06040'
  else if (pct >= 50) color = '#d4a017'

  const handleEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      setPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left + rect.width / 2 })
    }
    setHover(true)
  }

  return (
    <>
      <span
        ref={ref}
        className="text-[10px] px-0.5"
        style={{ color, cursor: 'default' }}
        onMouseEnter={handleEnter}
        onMouseLeave={() => setHover(false)}
      >
        {pct}%
      </span>
      {popoverLayer && hover && createPortal(
        <div
          style={{
            position: 'fixed',
            bottom: pos.bottom,
            left: pos.left,
            transform: 'translateX(-50%)',
            pointerEvents: 'none',
            background: colors.popoverBg,
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: `1px solid ${colors.popoverBorder}`,
            borderRadius: 6,
            padding: '3px 8px',
            fontSize: 10,
            color: colors.textSecondary,
            whiteSpace: 'nowrap',
            boxShadow: colors.popoverShadow,
          }}
        >
          {tooltip}
        </div>,
        popoverLayer,
      )}
    </>
  )
}
