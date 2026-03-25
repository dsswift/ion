import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { DotsThree, Bell, ArrowsOutSimple, Moon, Gear, Rows } from '@phosphor-icons/react'
import { useThemeStore } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import type { TabGroupMode } from '../../shared/types'

function RowToggle({
  checked,
  onChange,
  colors,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  colors: ReturnType<typeof useColors>
  label: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className="relative w-9 h-5 rounded-full transition-colors"
      style={{
        background: checked ? colors.accent : colors.surfaceSecondary,
        border: `1px solid ${checked ? colors.accent : colors.containerBorder}`,
      }}
    >
      <span
        className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full transition-all"
        style={{
          left: checked ? 18 : 2,
          background: '#fff',
        }}
      />
    </button>
  )
}

/* ─── Settings popover ─── */

function SegmentedControl({
  value,
  options,
  onChange,
  colors,
}: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  colors: ReturnType<typeof useColors>
}) {
  return (
    <div
      className="flex rounded-full overflow-hidden"
      style={{ background: colors.surfacePrimary, border: `1px solid ${colors.containerBorder}` }}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className="px-2 py-0.5 text-[10px] font-medium transition-colors"
          style={{
            background: value === opt.value ? colors.accent : 'transparent',
            color: value === opt.value ? colors.textOnAccent : colors.textTertiary,
            border: 'none',
            cursor: 'pointer',
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export function SettingsPopover() {
  const soundEnabled = useThemeStore((s) => s.soundEnabled)
  const setSoundEnabled = useThemeStore((s) => s.setSoundEnabled)
  const themeMode = useThemeStore((s) => s.themeMode)
  const setThemeMode = useThemeStore((s) => s.setThemeMode)
  const expandedUI = useThemeStore((s) => s.expandedUI)
  const setExpandedUI = useThemeStore((s) => s.setExpandedUI)
  const isExpanded = useSessionStore((s) => s.isExpanded)
  const tabGroupMode = useThemeStore((s) => s.tabGroupMode)
  const setTabGroupMode = useThemeStore((s) => s.setTabGroupMode)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const handleTabGroupModeChange = useCallback((newMode: TabGroupMode, oldMode: TabGroupMode) => {
    if (newMode === oldMode) return
    const sessionStore = useSessionStore.getState()

    if (newMode === 'manual' && oldMode === 'off') {
      const id = crypto.randomUUID()
      const group = { id, label: 'General', isDefault: true, order: 0, collapsed: true }
      useThemeStore.getState().setTabGroups([group])
      useSessionStore.setState((s) => ({
        tabs: s.tabs.map((t) => ({ ...t, groupId: id })),
      }))
    } else if (newMode === 'manual' && oldMode === 'auto') {
      const dirMap = new Map<string, typeof sessionStore.tabs>()
      for (const t of sessionStore.tabs) {
        const key = t.workingDirectory || '~'
        const arr = dirMap.get(key)
        if (arr) arr.push(t)
        else dirMap.set(key, [t])
      }
      const newGroups: Array<{ id: string; label: string; isDefault: boolean; order: number; collapsed: boolean }> = []
      const tabUpdates = new Map<string, string>()
      let order = 0
      for (const [dir, dirTabs] of dirMap) {
        const id = crypto.randomUUID()
        const label = dir.split('/').pop() || dir
        newGroups.push({ id, label, isDefault: order === 0, order, collapsed: true })
        for (const t of dirTabs) tabUpdates.set(t.id, id)
        order++
      }
      useThemeStore.getState().setTabGroups(newGroups)
      useSessionStore.setState((s) => ({
        tabs: s.tabs.map((t) => ({ ...t, groupId: tabUpdates.get(t.id) || null })),
      }))
    } else if (newMode === 'auto' && oldMode === 'manual') {
      useSessionStore.setState((s) => ({
        tabs: s.tabs.map((t) => ({ ...t, groupId: null })),
      }))
    }

    setTabGroupMode(newMode)
  }, [setTabGroupMode])

  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ right: number; top?: number; bottom?: number; maxHeight?: number }>({ right: 0 })

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const gap = 6 // Match HistoryPicker spacing exactly.
    const margin = 8
    const right = window.innerWidth - rect.right

    if (isExpanded) {
      // Keep anchored below trigger (so it never covers the dots button),
      // and shrink if needed instead of shifting upward onto the trigger.
      const top = rect.bottom + gap
      setPos({
        top,
        right,
        maxHeight: Math.max(120, window.innerHeight - top - margin),
      })
      return
    }

    // Same logic as HistoryPicker for collapsed mode: open upward from trigger.
    setPos({
      bottom: window.innerHeight - rect.top + gap,
      right,
      maxHeight: undefined,
    })
  }, [isExpanded])

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

  useEffect(() => {
    if (!open) return
    const onResize = () => updatePos()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open, updatePos])

  // Keep panel tracking the trigger continuously while open so it follows
  // width/position animations of the top bar without feeling "stuck in space."
  useEffect(() => {
    if (!open) return
    let raf = 0
    const tick = () => {
      updatePos()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [open, expandedUI, isExpanded, updatePos])

  const handleToggle = () => {
    if (!open) updatePos()
    setOpen((o) => !o)
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors"
        style={{ color: colors.textTertiary }}
        title="Settings"
      >
        <DotsThree size={16} weight="bold" />
      </button>

      {popoverLayer && open && createPortal(
        <motion.div
          ref={popoverRef}
          data-coda-ui
          initial={{ opacity: 0, y: isExpanded ? -4 : 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: isExpanded ? -4 : 4 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl"
          style={{
            position: 'fixed',
            ...(pos.top != null ? { top: pos.top } : {}),
            ...(pos.bottom != null ? { bottom: pos.bottom } : {}),
            right: pos.right,
            width: 240,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
            ...(pos.maxHeight != null ? { maxHeight: pos.maxHeight, overflowY: 'auto' as const } : {}),
          }}
        >
          <div className="p-3 flex flex-col gap-2.5">
            {/* Full width */}
            <div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <ArrowsOutSimple size={14} style={{ color: colors.textTertiary }} />
                  <div className="text-[12px] font-medium" style={{ color: colors.textPrimary }}>
                    Full width
                  </div>
                </div>
                <RowToggle
                  checked={expandedUI}
                  onChange={(next) => {
                    setExpandedUI(next)
                  }}
                  colors={colors}
                  label="Toggle full width panel"
                />
              </div>
            </div>

            <div style={{ height: 1, background: colors.popoverBorder }} />

            {/* Notification sound */}
            <div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Bell size={14} style={{ color: colors.textTertiary }} />
                  <div className="text-[12px] font-medium" style={{ color: colors.textPrimary }}>
                    Notification sound
                  </div>
                </div>
                <RowToggle
                  checked={soundEnabled}
                  onChange={setSoundEnabled}
                  colors={colors}
                  label="Toggle notification sound"
                />
              </div>
            </div>

            <div style={{ height: 1, background: colors.popoverBorder }} />

            {/* Theme */}
            <div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Moon size={14} style={{ color: colors.textTertiary }} />
                  <div className="text-[12px] font-medium" style={{ color: colors.textPrimary }}>
                    Dark theme
                  </div>
                </div>
                <RowToggle
                  checked={themeMode === 'dark'}
                  onChange={(next) => setThemeMode(next ? 'dark' : 'light')}
                  colors={colors}
                  label="Toggle dark theme"
                />
              </div>
            </div>

            <div style={{ height: 1, background: colors.popoverBorder }} />

            {/* Group tabs */}
            <div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Rows size={14} style={{ color: colors.textTertiary }} />
                  <div className="text-[12px] font-medium" style={{ color: colors.textPrimary }}>
                    Group tabs
                  </div>
                </div>
                <SegmentedControl
                  value={tabGroupMode}
                  options={[
                    { value: 'off', label: 'Off' },
                    { value: 'auto', label: 'Auto' },
                    { value: 'manual', label: 'Manual' },
                  ]}
                  onChange={(v) => {
                    const mode = v as TabGroupMode
                    handleTabGroupModeChange(mode, tabGroupMode)
                  }}
                  colors={colors}
                />
              </div>
            </div>

            <div style={{ height: 1, background: colors.popoverBorder }} />

            {/* All settings */}
            <button
              onClick={() => {
                setOpen(false)
                useSessionStore.getState().openSettings()
              }}
              className="flex items-center gap-2 w-full"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 0',
              }}
            >
              <Gear size={14} style={{ color: colors.textTertiary }} />
              <span className="text-[12px] font-medium" style={{ color: colors.textPrimary }}>
                Settings...
              </span>
            </button>
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}
