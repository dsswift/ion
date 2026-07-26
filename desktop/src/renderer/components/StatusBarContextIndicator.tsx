import React, { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { getDynamicContextWindow } from '../stores/model-labels'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { activeInstance } from '../stores/conversation-instance'
import { ContextRadial } from './StatusBarContextRadial'
import { resolveContextDisplay, formatTokens } from './context-usage'

/* ─── Context Usage Indicator ─── */

// The resolution math lives in context-usage.ts (pure, no React or theme
// imports) so the status bar, the radial, the drawer, and the tests all read
// the same shipped functions.

export function ContextIndicator() {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const preferredModel = usePreferencesStore((s) => s.preferredModel)
  const { contextTokens, modelOverride, sessionModel } = useSessionStore(
    useShallow((s) => {
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      // Per-conversation state (model + engine status) lives on the active
      // instance. statusFields.contextTokens is the single numerator: the
      // engine writes it on every status snapshot — seeded at session start
      // from the persisted conversation, updated per turn from the
      // occupancy usage event, and recomputed from disk at run exit. There
      // is no second "live" source to prefer over it; preferring one is
      // what let a cumulative-billing figure mask a 227k-token
      // conversation as 0%.
      const inst = tab ? activeInstance(s.conversationPanes, tab.id) : null
      return {
        contextTokens: inst?.statusFields?.contextTokens ?? null,
        modelOverride: inst?.modelOverride ?? null,
        sessionModel: inst?.sessionModel ?? null,
      }
    }),
  )

  const [hover, setHover] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })
  const toggleStatusDrawer = useSessionStore((s) => s.toggleStatusDrawer)

  // Effective picker-model: per-tab override > session model > global
  // preferred. This is the denominator, always — see resolveContextDisplay.
  const effectiveModel = modelOverride || sessionModel || preferredModel
  const windowSize = getDynamicContextWindow(effectiveModel)

  const display = resolveContextDisplay(contextTokens, windowSize)
  if (display === null) return null

  const tooltip = `${formatTokens(display.tokens)} / ${formatTokens(display.windowSize)} tokens`

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
        // ion-focusable normalizes the interactive transition timing; the
        // hover mechanics stay bespoke because hover here drives the token
        // tooltip, and the ring color is semantic (context-fill level), so
        // it does not swap on hover.
        className="px-0.5 ion-focusable"
        style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
        onClick={toggleStatusDrawer}
        onMouseEnter={handleEnter}
        onMouseLeave={() => setHover(false)}
        // The percentage is no longer rendered as text, so the accessible
        // name has to carry it.
        aria-label={`Context usage ${display.pct}% — ${tooltip}`}
      >
        <ContextRadial pct={display.pct} />
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
          {display.pct}% · {tooltip}
        </div>,
        popoverLayer,
      )}
    </>
  )
}
