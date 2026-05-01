import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { CaretDown, Check, Code, Copy } from '@phosphor-icons/react'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'

/* ─── Open With Picker ─── */

const OPEN_WITH_OPTIONS = [
  { id: 'vscode' as const, label: 'Open in VS Code', icon: Code },
]

export function OpenWithPicker() {
  const tab = useSessionStore(
    useShallow((s) => {
      const t = s.tabs.find((t) => t.id === s.activeTabId)
      return t ? { conversationId: t.conversationId, workingDirectory: t.workingDirectory } : undefined
    }),
  )
  const preferredOpenWith = usePreferencesStore((s) => s.preferredOpenWith)
  const setPreferredOpenWith = usePreferencesStore((s) => s.setPreferredOpenWith)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ bottom: 0, right: 0 })

  useEffect(() => { setOpen(false) }, [activeTabId])

  const updatePos = useCallback(() => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    setPos({
      bottom: window.innerHeight - rect.top + 6,
      right: window.innerWidth - rect.right,
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (containerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleExecute = () => {
    if (!tab) return
    window.ion.openInVSCode(tab.workingDirectory)
  }

  const handleToggle = () => {
    if (!open) updatePos()
    setOpen((o) => !o)
  }

  const handleSelect = (id: 'cli' | 'vscode') => {
    setPreferredOpenWith(id)
    setOpen(false)
  }

  const active = OPEN_WITH_OPTIONS.find((o) => o.id === preferredOpenWith) ?? OPEN_WITH_OPTIONS[0]
  const ActiveIcon = active.icon

  return (
    <>
      <div ref={containerRef} className="flex items-center">
        <button
          onClick={handleExecute}
          className="flex items-center gap-1 text-[11px] rounded-l-full pl-2 pr-1 py-0.5 transition-colors"
          style={{ color: colors.textTertiary, cursor: 'pointer' }}
          title={active.label}
        >
          {active.label}
          <ActiveIcon size={11} />
        </button>
        <button
          onClick={handleToggle}
          className="flex items-center rounded-r-full pr-1.5 py-0.5 transition-colors"
          style={{ color: colors.textTertiary, cursor: 'pointer' }}
          title="Switch open-with app"
        >
          <CaretDown size={9} style={{ opacity: 0.6 }} />
        </button>
      </div>

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
            right: pos.right,
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
            {OPEN_WITH_OPTIONS.map((opt) => {
              const Icon = opt.icon
              const isSelected = preferredOpenWith === opt.id
              return (
                <button
                  key={opt.id}
                  onClick={() => handleSelect(opt.id)}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] transition-colors"
                  style={{
                    color: isSelected ? colors.textPrimary : colors.textSecondary,
                    fontWeight: isSelected ? 600 : 400,
                  }}
                >
                  <span className="flex items-center gap-1.5">
                    <Icon size={12} />
                    {opt.label}
                  </span>
                  {isSelected && <Check size={12} style={{ color: colors.accent }} />}
                </button>
              )
            })}
            {tab?.conversationId && (
              <>
                <div className="mx-2 my-1" style={{ borderTop: `1px solid ${colors.popoverBorder}` }} />
                <button
                  onClick={() => {
                    if (tab.conversationId) navigator.clipboard.writeText(tab.conversationId)
                    setOpen(false)
                  }}
                  className="w-full flex items-center px-3 py-1.5 text-[11px] transition-colors"
                  style={{ color: colors.textSecondary }}
                >
                  <span className="flex items-center gap-1.5">
                    <Copy size={12} />
                    Copy Session ID
                  </span>
                </button>
              </>
            )}
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}
