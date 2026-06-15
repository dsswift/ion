import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { CaretDown, Check, ShieldCheck, ListChecks } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { useActiveEngineKey } from './StatusBarEngineHelpers'

/* ─── Permission Mode Picker ─── */

/**
 * Permission mode picker rendered in the unified `StatusBar` left
 * cluster. Sources state from a per-tab-type read path; the **write**
 * path is already routed correctly inside `setPermissionMode`
 * (tab-slice.ts:30-39) — it inspects the active tab and writes to
 * either `tabs[i].permissionMode` or `enginePermissionModes[key]`.
 *
 * Read paths:
 * - **Engine tabs**: `instance.permissionMode` on the active instance in
 *   `conversationPanes` (default 'auto' when no instance). Per-instance, since each
 *   engine sub-conversation can have its own permission mode.
 * - **Conversation tabs**: `tab.permissionMode` (default 'plan').
 *
 * Engine-only confirmation modal: on engine tabs, clicking the pill
 * pops up the "Change Mode" confirmation modal because extensions
 * typically control the permission mode on engine tabs and the user's
 * manual override may interfere with the extension's workflow. This
 * gating is engine-only per the plan's "each view keeps the same
 * components" rule — conversation tabs swap modes immediately on
 * click as today.
 */
export function PermissionModePicker() {
  // Read path: route by tab type. `permissionMode` resolves to 'auto'
  // (engine default) or 'plan' (conversation default) when the store
  // has no entry yet.
  const engineKey = useActiveEngineKey()
  const isEngine = engineKey != null
  const permissionMode = useSessionStore((s) => {
    if (engineKey) {
      const pane = s.conversationPanes.get(engineKey.tabId)
      const inst = pane?.instances.find((i) => i.id === engineKey.instanceId)
      return inst?.permissionMode ?? 'auto'
    }
    return s.tabs.find((t) => t.id === s.activeTabId)?.permissionMode ?? 'plan'
  })
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const [open, setOpen] = useState(false)
  const [showModeConfirm, setShowModeConfirm] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
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
    if (isEngine) {
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
    ? '#2eb8a6'
    : colors.textTertiary

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5 transition-colors"
        style={{
          color: modeColor,
          cursor: 'pointer',
        }}
        title={isEngine ? 'Permission mode — extensions control this; click to override' : 'Permission mode (this tab)'}
      >
        {modeIcon}
        {modeLabel}
        {/* Conversation tabs show a caret because the click opens a
            popover with explicit Plan/Auto choices. Engine tabs go
            straight to the confirm modal so no caret is needed. */}
        {!isEngine && <CaretDown size={10} style={{ opacity: 0.6 }} />}
      </button>

      {/* Conversation popover — Plan/Auto choices, applied immediately. */}
      {!isEngine && popoverLayer && open && createPortal(
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
            <button
              onClick={() => { setPermissionMode('plan', 'ui_dropdown'); setOpen(false) }}
              className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] transition-colors"
              style={{
                color: permissionMode === 'plan' ? colors.textPrimary : colors.textSecondary,
                fontWeight: permissionMode === 'plan' ? 600 : 400,
              }}
            >
              <span className="flex items-center gap-1.5">
                <ListChecks size={12} weight="bold" />
                Plan
              </span>
              {permissionMode === 'plan' && <Check size={12} style={{ color: colors.accent }} />}
            </button>

            <div className="mx-2 my-0.5" style={{ height: 1, background: colors.popoverBorder }} />

            <button
              onClick={() => { setPermissionMode('auto', 'ui_dropdown'); setOpen(false) }}
              className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] transition-colors"
              style={{
                color: permissionMode === 'auto' ? colors.textPrimary : colors.textSecondary,
                fontWeight: permissionMode === 'auto' ? 600 : 400,
              }}
            >
              <span className="flex items-center gap-1.5">
                <ShieldCheck size={12} weight="fill" />
                Auto
              </span>
              {permissionMode === 'auto' && <Check size={12} style={{ color: colors.accent }} />}
            </button>
          </div>
        </motion.div>,
        popoverLayer,
      )}

      {/* Engine confirmation modal — extracted verbatim from the prior
          former engine status bar. Confirms an override of the
          extension-controlled mode before flipping. */}
      {isEngine && popoverLayer && showModeConfirm && createPortal(
        <div
          data-ion-ui
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
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
                style={{
                  background: 'none',
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
                style={{
                  background: colors.accent,
                  border: 'none',
                  borderRadius: 6,
                  padding: '5px 14px',
                  fontSize: 12,
                  color: '#fff',
                  fontWeight: 600,
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
