import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { DotsThree, Gear, ListChecks, ClipboardText, Bug, FolderOpen } from '@phosphor-icons/react'
import { usePreferencesStore } from '../preferences'
import { useSessionStore } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'

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

/* ─── Transcript formatting ─── */

function formatTranscript(messages: Array<{ role: string; content: string }>): string {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0)
    .map((m) => `[${m.role}]: ${m.content}`)
    .join('\n\n')
}

/* ─── Settings popover ─── */

export function SettingsPopover() {
  const showTodoList = usePreferencesStore((s) => s.showTodoList)
  const setShowTodoList = usePreferencesStore((s) => s.setShowTodoList)
  const expandedUI = usePreferencesStore((s) => s.expandedUI)
  const isExpanded = useSessionStore((s) => s.isExpanded)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

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

  const handleCopyTranscript = () => {
    const { activeTabId, tabs, engineMessages, enginePanes } = useSessionStore.getState()
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return

    let messages: Array<{ role: string; content: string }>
    if (tab.isEngine) {
      // Engine tabs: messages keyed by tabId:instanceId
      const pane = enginePanes.get(tab.id)
      const key = pane?.activeInstanceId ? `${tab.id}:${pane.activeInstanceId}` : ''
      messages = key ? (engineMessages.get(key) || []) : []
    } else {
      messages = tab.messages
    }

    const transcript = formatTranscript(messages)
    if (!transcript) return

    navigator.clipboard.writeText(transcript)
    setOpen(false)
  }

  const handleCopyDebugInfo = () => {
    const {
      activeTabId,
      tabs,
      staticInfo,
      backend,
      enginePanes,
      engineStatusFields,
      engineConversationIds,
    } = useSessionStore.getState()
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return

    const homeDir = staticInfo?.homePath || '~'
    let payload: string

    if (tab.isEngine) {
      // Each engine restart writes a new conversation file. Copy every
      // file the engine has produced for this instance, newest last, so
      // the user can see the full history (including the runaway that
      // pushed the engine to restart in the first place).
      const pane = enginePanes.get(tab.id)
      const key = pane?.activeInstanceId ? `${tab.id}:${pane.activeInstanceId}` : ''
      if (!key) return
      const ids = engineConversationIds.get(key) ?? []
      const current = engineStatusFields.get(key)?.sessionId
      const allIds = current && !ids.includes(current) ? [...ids, current] : ids
      if (allIds.length === 0) return
      const paths = allIds.map((id) => `${homeDir}/.ion/conversations/${id}.jsonl`)
      payload = paths.join('\n')
    } else {
      if (!tab.conversationId) return
      if (backend === 'api') {
        payload = `${homeDir}/.ion/conversations/${tab.conversationId}.jsonl`
      } else {
        const encodedPath = tab.workingDirectory.replace(/[/.]/g, '-')
        payload = `${homeDir}/.claude/projects/${encodedPath}/${tab.conversationId}.jsonl`
      }
    }

    navigator.clipboard.writeText(payload)
    setOpen(false)
  }

  const handleRevealConversationsFolder = () => {
    const { staticInfo } = useSessionStore.getState()
    const homeDir = staticInfo?.homePath
    if (!homeDir) return
    window.ion.fsOpenNative(`${homeDir}/.ion/conversations`).catch(() => {})
    setOpen(false)
  }

  // Check if debug info can be copied
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const tabs = useSessionStore((s) => s.tabs)
  const enginePanes = useSessionStore((s) => s.enginePanes)
  const engineStatusFields = useSessionStore((s) => s.engineStatusFields)
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const hasDebugInfo = (() => {
    if (!activeTab) return false
    if (activeTab.isEngine) {
      const pane = enginePanes.get(activeTab.id)
      const key = pane?.activeInstanceId ? `${activeTab.id}:${pane.activeInstanceId}` : ''
      return !!(key && engineStatusFields.get(key)?.sessionId)
    }
    return !!activeTab.conversationId
  })()

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
          data-ion-ui
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
            {/* Task list */}
            <div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <ListChecks size={14} style={{ color: colors.textTertiary }} />
                  <div className="text-[12px] font-medium" style={{ color: colors.textPrimary }}>
                    Task list
                  </div>
                </div>
                <RowToggle
                  checked={showTodoList}
                  onChange={setShowTodoList}
                  colors={colors}
                  label="Toggle task list visibility"
                />
              </div>
            </div>

            <div style={{ height: 1, background: colors.popoverBorder }} />

            {/* Copy transcript */}
            <button
              onClick={handleCopyTranscript}
              className="flex items-center gap-2 w-full"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 0',
              }}
            >
              <ClipboardText size={14} style={{ color: colors.textTertiary }} />
              <span className="text-[12px] font-medium" style={{ color: colors.textPrimary }}>
                Copy transcript
              </span>
            </button>

            <div style={{ height: 1, background: colors.popoverBorder }} />

            {/* Copy log path */}
            <button
              onClick={handleCopyDebugInfo}
              disabled={!hasDebugInfo}
              className="flex items-center gap-2 w-full"
              style={{
                background: 'none',
                border: 'none',
                cursor: hasDebugInfo ? 'pointer' : 'default',
                padding: '2px 0',
                opacity: hasDebugInfo ? 1 : 0.4,
              }}
              title="Copies every conversation file the engine has written for this tab. Multiple paths are newline-separated."
            >
              <Bug size={14} style={{ color: colors.textTertiary }} />
              <span className="text-[12px] font-medium" style={{ color: colors.textPrimary }}>
                Copy log path
              </span>
            </button>

            {/* Reveal conversations folder in Finder */}
            <button
              onClick={handleRevealConversationsFolder}
              className="flex items-center gap-2 w-full"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '2px 0',
              }}
              title="Open ~/.ion/conversations in Finder."
            >
              <FolderOpen size={14} style={{ color: colors.textTertiary }} />
              <span className="text-[12px] font-medium" style={{ color: colors.textPrimary }}>
                Reveal conversations folder
              </span>
            </button>

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
