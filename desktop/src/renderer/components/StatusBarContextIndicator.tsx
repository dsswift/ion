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
      return {
        contextTokens: tab?.contextTokens ?? null,
        contextPercent: tab?.contextPercent ?? null,
        // engineContextWindow is the window size of the model the engine
        // actually used on the most recent turn. Distinct from the
        // picker-selected model's nominal window. Renderers MUST use
        // this as the denominator when recomputing percent locally;
        // see the rationale at types-session.ts contextWindow doc.
        engineContextWindow: tab?.contextWindow ?? null,
        modelOverride: inst?.modelOverride ?? null,
        sessionModel: inst?.sessionModel ?? null,
      }
    }),
  )

  const [hover, setHover] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

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

  // Local percent recomputation: when contextTokens is available, divide
  // by the engine's reported window (anchored to the model that produced
  // those tokens). When contextTokens is null, fall back to the engine's
  // pre-computed contextPercent. The cap at 100 is a display guard —
  // engine-truth math never exceeds 100% when both sides come from the
  // same model; the cap protects against transient mismatch during
  // the cold-start window before contextWindow has been reported.
  const pct = contextTokens != null
    ? Math.min(100, Math.round((contextTokens / windowSize) * 100))
    : contextPercent

  if (pct === null) return null

  const tokens = contextTokens ?? (pct * windowSize / 100)
  const formatTokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`
  const tooltip = `${formatTokens(tokens)} / ${formatTokens(windowSize)} tokens`

  let color = colors.textTertiary
  if (pct >= 80) color = '#e06040'
  else if (pct >= 60) color = '#d4a017'

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
