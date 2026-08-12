import React, { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { getDynamicContextWindow } from '../stores/model-labels'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { useViewportClamp } from '../hooks/useViewportClamp'
import { usePreferencesStore } from '../preferences'
import { activeInstance } from '../stores/conversation-instance'
import { ContextRadial } from './StatusBarContextRadial'
import { resolveContextDisplay, resolveContextInputs, formatTokens } from './context-usage'

/* ─── Context Usage Indicator ─── */

// The resolution math lives in context-usage.ts (pure, no React or theme
// imports) so the status bar, the radial, the drawer, and the tests all read
// the same shipped functions.

export function ContextIndicator() {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const preferredModel = usePreferencesStore((s) => s.preferredModel)
  const { contextTokens, engineWindow, modelOverride, sessionModel } = useSessionStore(
    useShallow((s) => {
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      // Per-conversation state (model + engine status) lives on the active
      // instance. resolveContextInputs picks the occupancy numerator and the
      // engine-window fallback; the drawer calls the same helper, so the two
      // surfaces cannot read different fields or order them differently.
      const inst = tab ? activeInstance(s.conversationPanes, tab.id) : null
      const { tokens, engineWindow } = resolveContextInputs(inst)
      return {
        contextTokens: tokens,
        engineWindow,
        modelOverride: inst?.modelOverride ?? null,
        sessionModel: inst?.sessionModel ?? null,
      }
    }),
  )

  const [hover, setHover] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  // Edge-anchored tooltip (grows upward out of the status bar). Centred with a
  // translateX(-50%), which the clamp's `translate` composes with rather than
  // overwriting — so a radial near either window edge stays readable.
  const tipRef = useRef<HTMLDivElement>(null)
  useViewportClamp(tipRef, hover)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })
  const toggleStatusDrawer = useSessionStore((s) => s.toggleStatusDrawer)

  // Effective picker-model: per-tab override > session model > global
  // preferred. This is the denominator, always — see resolveContextDisplay.
  // The engine-reported window backs it up for models neither the dynamic
  // store nor the static catalog knows, so an unrecognized id can no longer
  // silently divide by the 200k floor.
  const effectiveModel = modelOverride || sessionModel || preferredModel
  const windowSize = getDynamicContextWindow(effectiveModel, engineWindow)

  // The radial is a persistent status-bar affordance, not a data-availability
  // signal. Before the engine reports occupancy, and after a reset to zero,
  // render its neutral empty state rather than removing its click target.
  const display = resolveContextDisplay(contextTokens, windowSize) ?? {
    pct: 0,
    tokens: 0,
    windowSize,
  }

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
          ref={tipRef}
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
