import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { CaretDown, Check, ShieldCheck, ListChecks } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'

/* ─── Permission Mode Picker (per-tab) ─── */

export function PermissionModePicker() {
  const permissionMode = useSessionStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.permissionMode ?? 'plan'
  )
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const backend = useSessionStore((s) => s.backend)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  useEffect(() => { setOpen(false) }, [activeTabId])

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

  // CLI mode doesn't support plan mode
  if (backend === 'cli') {
    return (
      <span
        className="flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5"
        style={{ color: colors.textTertiary }}
      >
        <ShieldCheck size={11} weight="fill" />
        Auto
      </span>
    )
  }

  const handleToggle = () => {
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
        title="Permission mode (this tab)"
      >
        {modeIcon}
        {modeLabel}
        <CaretDown size={10} style={{ opacity: 0.6 }} />
      </button>

      {popoverLayer && open && createPortal(
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
    </>
  )
}
