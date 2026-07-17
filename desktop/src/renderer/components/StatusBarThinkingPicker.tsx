import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useViewportClamp } from '../hooks/useViewportClamp'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { CaretDown, Check, Brain } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { useModelStore } from '../stores/model-store'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { activeInstance } from '../stores/conversation-instance'
import type { ThinkingEffort } from '../../shared/types-session'

/* ─── Thinking Effort Picker ─── */

/**
 * Per-conversation extended-thinking control rendered in the unified
 * `StatusBar` left cluster.
 *
 * Read path: `instance.thinkingEffort` on the active conversation instance
 * for EVERY tab type. `TabState.thinkingEffort` is gone (WI-002). Both
 * default to 'off'.
 *
 * Visibility gate (two conditions, both required):
 * 1. The global `thinkingEnabled` preference is ON. When off, the whole
 *    feature is disabled and this control does not render.
 * 2. The active model declares a non-empty `thinkingEfforts` set. A model
 *    that does not support reasoning hides the control (rendering it would
 *    let the user pick a level the engine would then drop).
 *
 * The selected level is applied LIVE on the next prompt — there is no engine
 * call here; the prompt-submit path reads the level and rides it on
 * send_prompt as `thinkingEffort`.
 */

const LEVELS: Array<{ value: ThinkingEffort; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

export function ThinkingPicker() {
  const thinkingEnabled = usePreferencesStore((s) => s.thinkingEnabled)

  // Per-conversation effort (default 'off') read from the active instance for
  // EVERY tab type — the unified home for the per-conversation thinking effort
  // (matches the unified submit, which reads it from the instance). No
  // engine-vs-plain fork.
  const effort = useSessionStore((s): ThinkingEffort => {
    const inst = activeInstance(s.conversationPanes, s.activeTabId)
    return inst?.thinkingEffort ?? 'off'
  })

  // Resolve the active model to read its allowed thinking efforts — from the
  // same active instance (modelOverride / sessionModel), else preferred model.
  const preferredModel = usePreferencesStore((s) => s.preferredModel)
  const activeModelId = useSessionStore((s) => {
    const inst = activeInstance(s.conversationPanes, s.activeTabId)
    return inst?.modelOverride || inst?.sessionModel || preferredModel
  })
  const findModel = useModelStore((s) => s.findModel)
  const modelEntry = activeModelId ? findModel(activeModelId) : undefined
  const allowedEfforts = modelEntry?.thinkingEfforts ?? []
  const modelSupportsThinking = allowedEfforts.length > 0

  const setThinkingEffort = useSessionStore((s) => s.setThinkingEffort)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  // Keep the portaled popover inside the window (ATV top-anchored strip).
  useViewportClamp(popoverRef, open)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  useEffect(() => { setOpen(false) }, [activeTabId])

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setPos({ bottom: window.innerHeight - rect.top + 6, left: rect.left })
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Global gate: feature off → render nothing.
  if (!thinkingEnabled) return null

  const handleToggle = () => {
    if (!modelSupportsThinking) return
    if (!open) updatePos()
    setOpen((o) => !o)
  }

  const isActive = effort !== 'off'
  const label = LEVELS.find((l) => l.value === effort)?.label ?? 'Off'
  const color = isActive ? '#8b7fd4' : colors.textTertiary

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        disabled={!modelSupportsThinking}
        className="flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5 transition-colors"
        style={{
          color: modelSupportsThinking ? color : colors.textTertiary,
          opacity: modelSupportsThinking ? 1 : 0.4,
          cursor: modelSupportsThinking ? 'pointer' : 'default',
        }}
        title={
          modelSupportsThinking
            ? 'Extended thinking (this conversation)'
            : 'This model does not support extended thinking'
        }
      >
        <Brain size={11} weight={isActive ? 'fill' : 'regular'} />
        {`Think: ${label}`}
        {modelSupportsThinking && <CaretDown size={10} style={{ opacity: 0.6 }} />}
      </button>

      {modelSupportsThinking && popoverLayer && open && createPortal(
        <motion.div
          ref={popoverRef}
          data-ion-ui
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl"
          style={{
            position: 'fixed',
            bottom: pos.bottom,
            left: pos.left,
            width: 180,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
          }}
        >
          <div className="py-1">
            {LEVELS.map((lvl, i) => {
              // Off is always available; other levels only when the model
              // declares them. A model may, e.g., support low/high but not
              // medium (grok-mini) — hide the levels it does not allow.
              const available = lvl.value === 'off' || allowedEfforts.includes(lvl.value)
              if (!available) return null
              const selected = effort === lvl.value
              return (
                <React.Fragment key={lvl.value}>
                  {i > 0 && <div className="mx-2 my-0.5" style={{ height: 1, background: colors.popoverBorder }} />}
                  <button
                    onClick={() => { setThinkingEffort(lvl.value); setOpen(false) }}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] transition-colors"
                    style={{
                      color: selected ? colors.textPrimary : colors.textSecondary,
                      fontWeight: selected ? 600 : 400,
                    }}
                  >
                    <span className="flex items-center gap-1.5">
                      <Brain size={12} weight={lvl.value === 'off' ? 'regular' : 'fill'} />
                      {lvl.label}
                    </span>
                    {selected && <Check size={12} style={{ color: colors.accent }} />}
                  </button>
                </React.Fragment>
              )
            })}
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}
