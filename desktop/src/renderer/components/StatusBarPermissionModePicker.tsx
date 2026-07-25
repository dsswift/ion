import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useViewportClamp } from '../hooks/useViewportClamp'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { CaretDown, Check, ShieldCheck, ListChecks } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { effectivePermissionMode } from '../stores/conversation-instance'
import { tabHasExtensions } from '../../shared/tab-predicates'

/* ─── Permission Mode Picker ─── */

/** One row in the Plan/Auto popover. A separate component so each row owns
 * its own useInteractiveState hook (rules-of-hooks: one hook per element). */
function ModeOptionRow({ colors, selected, icon, label, onSelect }: {
  colors: ReturnType<typeof useColors>
  selected: boolean
  icon: React.ReactNode
  label: string
  onSelect: () => void
}) {
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      onClick={onSelect}
      {...handlers}
      className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] ion-focusable"
      style={{
        color: selected ? colors.textPrimary : colors.textSecondary,
        fontWeight: selected ? 500 : 400,
        background: interactiveBg(colors, { hover, pressed, selected }),
      }}
    >
      <span className="flex items-center gap-1.5">
        {icon}
        {label}
      </span>
      {selected && <Check size={12} style={{ color: colors.accent }} />}
    </button>
  )
}

/**
 * Permission mode picker rendered in the unified `StatusBar` left
 * cluster. Sources state from the active conversation instance — the single
 * home for permissionMode for every tab type (WI-002). The **write** path
 * inside `setPermissionMode` (tab-slice.ts) also writes to the instance.
 *
 * `permissionModeGoverned` is a DISPLAY predicate: "does an extension/harness
 * govern this conversation's permission mode?" (i.e. `tabHasExtensions`). A
 * governed conversation shows a confirm modal on click; an ungoverned one
 * shows the direct Plan/Auto popover. This is the only remaining use of
 * `tabHasExtensions` in this file — it gates the UX affordance (F-13a), not
 * the storage-home read.
 */
export function PermissionModePicker() {
  // Read the AUTHORITATIVE permission mode through the single unified seam.
  // effectivePermissionMode reads the active conversation instance for every
  // tab type — no tab-type fork. `permissionModeGoverned` is a DISPLAY flag
  // for the confirm-modal UX (F-13a), not a storage-home branch.
  const activeTab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const permissionModeGoverned = activeTab ? tabHasExtensions(activeTab) : false
  const permissionMode = useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return 'plan'
    return effectivePermissionMode(tab, s.conversationPanes)
  })
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const [open, setOpen] = useState(false)
  const [showModeConfirm, setShowModeConfirm] = useState(false)
  // Pointer states: trigger pill + the two confirm-modal buttons.
  const triggerState = useInteractiveState()
  const cancelBtnState = useInteractiveState()
  const confirmBtnState = useInteractiveState()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  // Keep the portaled popover inside the window (ATV top-anchored strip).
  useViewportClamp(popoverRef, open)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  useEffect(() => { setOpen(false); setShowModeConfirm(false) }, [activeTabId])

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setPos({
      bottom: window.innerHeight - rect.top + 6,
      left: rect.left,
    })
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

  const handleToggle = () => {
    // Engine tabs: clicking the pill opens the confirmation modal
    // instead of the popover — extensions usually control permission
    // mode on engine tabs and we don't want to silently fight them.
    // Mirrors the prior behavior of the former engine status bar's
    // permission-mode pill click handler.
    if (permissionModeGoverned) {
      setShowModeConfirm(true)
      return
    }
    if (!open) updatePos()
    setOpen((o) => !o)
  }

  const modeLabel = permissionMode === 'plan' ? 'Plan' : 'Auto'
  const modeIcon = permissionMode === 'plan'
    ? <ListChecks size={11} weight="bold" />
    : <ShieldCheck size={11} weight="fill" />
  const modeColor = permissionMode === 'plan'
    ? colors.modeAcceptEdits
    : colors.textTertiary

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        {...triggerState.handlers}
        className="flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5 ion-focusable"
        style={{
          color: modeColor,
          background: interactiveBg(colors, triggerState),
          cursor: 'pointer',
        }}
        title={permissionModeGoverned ? 'Permission mode — extensions control this; click to override' : 'Permission mode (this tab)'}
      >
        {modeIcon}
        {modeLabel}
        {/* Conversation tabs show a caret because the click opens a
            popover with explicit Plan/Auto choices. Engine tabs go
            straight to the confirm modal so no caret is needed. */}
        {!permissionModeGoverned && <CaretDown size={10} style={{ opacity: 0.6 }} />}
      </button>

      {/* Conversation popover — Plan/Auto choices, applied immediately. */}
      {!permissionModeGoverned && popoverLayer && open && createPortal(
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
            <ModeOptionRow
              colors={colors}
              selected={permissionMode === 'plan'}
              icon={<ListChecks size={12} weight="bold" />}
              label="Plan"
              onSelect={() => { setPermissionMode('plan', 'ui_dropdown'); setOpen(false) }}
            />

            <div className="mx-2 my-0.5" style={{ height: 1, background: colors.popoverBorder }} />

            <ModeOptionRow
              colors={colors}
              selected={permissionMode === 'auto'}
              icon={<ShieldCheck size={12} weight="fill" />}
              label="Auto"
              onSelect={() => { setPermissionMode('auto', 'ui_dropdown'); setOpen(false) }}
            />
          </div>
        </motion.div>,
        popoverLayer,
      )}

      {/* Engine confirmation modal — extracted verbatim from the prior
          former engine status bar. Confirms an override of the
          extension-controlled mode before flipping. */}
      {permissionModeGoverned && popoverLayer && showModeConfirm && createPortal(
        <div
          data-ion-ui
          style={{
            position: 'fixed',
            inset: 0,
            background: colors.scrim,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
            pointerEvents: 'auto',
          }}
          onClick={() => setShowModeConfirm(false)}
        >
          <div
            data-ion-ui
            onClick={(e) => e.stopPropagation()}
            style={{
              background: colors.popoverBg,
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              border: `1px solid ${colors.popoverBorder}`,
              borderRadius: 12,
              padding: '16px 20px',
              maxWidth: 340,
              boxShadow: colors.popoverShadow,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: colors.textPrimary, marginBottom: 8 }}>
              Change Mode
            </div>
            <div style={{ fontSize: 12, color: colors.textSecondary, lineHeight: 1.5, marginBottom: 16 }}>
              The extension controls this tab&apos;s planning mode. Changing it manually may interfere with the extension&apos;s workflow.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                data-ion-ui
                onClick={() => setShowModeConfirm(false)}
                {...cancelBtnState.handlers}
                className="ion-focusable"
                style={{
                  background: interactiveBg(colors, cancelBtnState),
                  border: `1px solid ${colors.containerBorder}`,
                  borderRadius: 6,
                  padding: '5px 14px',
                  fontSize: 12,
                  color: colors.textSecondary,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                data-ion-ui
                onClick={() => {
                  setPermissionMode(permissionMode === 'plan' ? 'auto' : 'plan', 'ui_dropdown')
                  setShowModeConfirm(false)
                }}
                {...confirmBtnState.handlers}
                className="ion-focusable"
                style={{
                  // Accent CTA: accentHover / accentPressed are the accent
                  // button states from the style guide.
                  background: confirmBtnState.pressed
                    ? colors.accentPressed
                    : confirmBtnState.hover
                      ? colors.accentHover
                      : colors.accent,
                  border: 'none',
                  borderRadius: 6,
                  padding: '5px 14px',
                  fontSize: 12,
                  color: colors.textOnAccent,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Switch to {permissionMode === 'plan' ? 'Auto' : 'Plan'}
              </button>
            </div>
          </div>
        </div>,
        popoverLayer,
      )}
    </>
  )
}
