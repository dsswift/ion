import React, { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { getDynamicContextWindow } from '../stores/model-labels'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { activeInstance } from '../stores/conversation-instance'

/* ─── Context Percentage Indicator ─── */

export function ContextIndicator() {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const preferredModel = usePreferencesStore((s) => s.preferredModel)
  const { contextTokens, contextPercent, engineContextWindow, modelOverride, sessionModel } = useSessionStore(
    useShallow((s) => {
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      // Per-conversation model state now lives on the active instance
      // (`modelOverride` / `sessionModel`), resolved via `activeInstance`.
      const inst = tab ? activeInstance(s.conversationPanes, tab.id) : null
      // During a live run: contextTokens is set from `usage` events; contextWindow is
      // written from context_breakdown (added in B3/B4). When the run is idle,
      // both go null and we fall back to the engine's last-known statusFields
      // (the authoritative idle heartbeat source the drawer already uses).
      const liveTokens = tab?.contextTokens ?? null
      const liveWindow = tab?.contextWindow ?? null
      const sfPercent = inst?.statusFields?.contextPercent ?? null
      const sfWindow = inst?.statusFields?.contextWindow ?? null
      return {
        // During a live run: use the live token count + contextWindow from context_breakdown.
        // At idle / after reload: fall back to statusFields which carry the engine's
        // last-known fill (seeded on resume by B1/B2 engine changes).
        contextTokens: liveTokens,
        contextPercent: liveTokens !== null ? null : sfPercent,
        // Denominator priority: live breakdown window > statusFields window > null (picker fallback)
        engineContextWindow: liveWindow ?? sfWindow,
        modelOverride: inst?.modelOverride ?? null,
        sessionModel: inst?.sessionModel ?? null,
      }
    }),
  )

  const [hover, setHover] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })
  const toggleStatusDrawer = useSessionStore((s) => s.toggleStatusDrawer)

  // Resolve effective picker-model: per-tab override > session model >
  // global preferred. Used ONLY as the fallback denominator when the
  // engine has not yet reported a window (cold-start tabs, post-clear
  // state). Once the engine has answered at least once, the numerator
  // and denominator must come from the same model — see the bug
  // diagnosed in plan cosy-pacing-bee.md (a Sonnet-picker reading
  // displayed an Opus conversation as 100% / 498k / 200k because the
  // denominator was the picker's nominal window).
  const effectiveModel = modelOverride || sessionModel || preferredModel
  const fallbackWindow = getDynamicContextWindow(effectiveModel)

  // Compute the denominator: prefer the engine-truth window over the
  // picker fallback. Both numerator and denominator must come from the
  // same model the engine actually billed.
  const windowSize = engineContextWindow ?? fallbackWindow

  // Local percent recomputation: when contextTokens is available (live run),
  // divide by the engine's reported window (anchored to the model that produced
  // those tokens). When contextTokens is null (idle/reload), fall back to the
  // engine's pre-computed contextPercent from statusFields — which is seeded on
  // session resume by the B1/B2 engine fix so idle tabs show the real last fill.
  // The cap at 100 is a display guard against transient mismatch.
  const pct = contextTokens != null
    ? Math.min(100, Math.round((contextTokens / windowSize) * 100))
    : contextPercent

  if (pct === null) return null

  const tokens = contextTokens ?? (pct * windowSize / 100)
  const formatTokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`
  const tooltip = `${formatTokens(tokens)} / ${formatTokens(windowSize)} tokens`

  let color = colors.textTertiary
  if (pct >= 80) color = colors.dangerFg
  else if (pct >= 60) color = colors.warningFg

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
        // tooltip, and the color itself is semantic (context-fill level),
        // so it does not swap on hover.
        className="text-[10px] px-0.5 ion-focusable"
        style={{ color, cursor: 'pointer' }}
        onClick={toggleStatusDrawer}
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
