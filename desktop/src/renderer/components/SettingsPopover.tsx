import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useViewportClamp } from '../hooks/useViewportClamp'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { DotsThree, Gear, ListChecks, ClipboardText, Bug, FolderOpen, Hash } from '@phosphor-icons/react'
import { usePreferencesStore } from '../preferences'
import { useSessionStore } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { activeInstance } from '../stores/conversation-instance'
import { tabHasExtensions, computeSessionIdCopyPayload } from '../../shared/tab-predicates'
import { rDebug, rError } from '../rendererLogger'

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
  const { hover, pressed, handlers } = useInteractiveState()
  // Checked track darkens through the accent ladder; unchecked track
  // follows the standard surface cascade over its surfaceSecondary base.
  const track = checked
    ? (pressed ? colors.accentPressed : hover ? colors.accentHover : colors.accent)
    : interactiveBg(colors, { hover, pressed }, colors.surfaceSecondary)
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      {...handlers}
      className="ion-focusable relative w-9 h-5 rounded-full"
      style={{
        background: track,
        border: `1px solid ${checked ? colors.accent : colors.containerBorder}`,
        transition: `background ${transitions.base}, border-color ${transitions.base}`,
      }}
    >
      <span
        className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full transition-all"
        style={{
          left: checked ? 18 : 2,
          background: colors.textOnAccent,
        }}
      />
    </button>
  )
}

/** One popover action row (icon + label). Extracted so `useInteractiveState`
 *  runs per row; disabled rows get the standard treatment (opacity 0.45,
 *  default cursor, inert hover/pressed handlers). */
function PopoverActionRow({ icon, label, onClick, disabled = false, title }: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  title?: string
}) {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={disabled ? undefined : handlers.onMouseEnter}
      onMouseLeave={handlers.onMouseLeave}
      onMouseDown={disabled ? undefined : handlers.onMouseDown}
      onMouseUp={disabled ? undefined : handlers.onMouseUp}
      onBlur={handlers.onBlur}
      className="ion-focusable flex items-center gap-2 w-full"
      style={{
        background: disabled ? 'transparent' : interactiveBg(colors, { hover, pressed }),
        border: 'none',
        cursor: disabled ? 'default' : 'pointer',
        padding: '2px 0',
        borderRadius: 4,
        opacity: disabled ? 0.45 : 1,
        transition: `background ${transitions.base}`,
      }}
    >
      {icon}
      <span className="text-[12px] font-medium" style={{ color: colors.textPrimary }}>
        {label}
      </span>
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
  const triggerIx = useInteractiveState()
  const showTodoList = usePreferencesStore((s) => s.showTodoList)
  const setShowTodoList = usePreferencesStore((s) => s.setShowTodoList)
  const expandedUI = usePreferencesStore((s) => s.expandedUI)
  const isExpanded = useSessionStore((s) => s.isExpanded)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  // Keep the portaled popover inside the window (Studio top-anchored strip).
  useViewportClamp(popoverRef, open)
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
    const { activeTabId, tabs, conversationPanes } = useSessionStore.getState()
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return

    // Messages live on the active `ConversationInstance` for every tab type
    // (normal tabs carry a single `main` instance), so there is no longer a
    // `tabHasExtensions` fork — `activeInstance` resolves the right instance.
    const messages: Array<{ role: string; content: string }> =
      activeInstance(conversationPanes, tab.id)?.messages ?? []

    const transcript = formatTranscript(messages)
    if (!transcript) return

    navigator.clipboard.writeText(transcript).catch((err) => rError('settings-popover', 'copy transcript failed', { error: String(err) }))
    setOpen(false)
  }

  const handleCopyDebugInfo = async () => {
    const {
      activeTabId,
      tabs,
      staticInfo,
      conversationPanes,
    } = useSessionStore.getState()
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return

    const homeDir = staticInfo?.homePath || '~'
    let payload: string

    if (tabHasExtensions(tab)) {
      // Each engine restart writes a new conversation file. Copy every
      // file the engine has produced for this instance, newest last.
      const pane = conversationPanes.get(tab.id)
      const inst = pane?.activeInstanceId ? pane.instances.find(i => i.id === pane.activeInstanceId) : null
      if (!inst) return
      const ids = inst.conversationIds
      const current = inst.statusFields?.sessionId
      const allIds = current && !ids.includes(current) ? [...ids, current] : ids
      if (allIds.length === 0) return
      const paths = allIds.map((id) => `${homeDir}/.ion/conversations/${id}.jsonl`)
      payload = paths.join('\n')
    } else {
      const sessionId = tab.conversationId || tab.lastKnownSessionId
      if (!sessionId) return
      // Per-conversation store selection (no global mode): an Ion
      // conversation file exists iff the API backend served it; otherwise
      // the history lives in the Claude CLI's own store.
      const inIonStore = await window.ion.conversationExists(sessionId)
      if (inIonStore) {
        payload = `${homeDir}/.ion/conversations/${sessionId}.jsonl`
      } else {
        const encodedPath = tab.workingDirectory.replace(/[/.]/g, '-')
        payload = `${homeDir}/.claude/projects/${encodedPath}/${sessionId}.jsonl`
      }
    }

    navigator.clipboard.writeText(payload).catch((err) => rError('settings-popover', 'copy debug info failed', { error: String(err) }))
    setOpen(false)
  }

  const handleCopySessionId = () => {
    const {
      activeTabId,
      tabs,
      conversationPanes,
    } = useSessionStore.getState()
    const tab = tabs.find((t) => t.id === activeTabId)
    if (!tab) return

    const pane = conversationPanes.get(tab.id)
    const inst = pane?.activeInstanceId ? pane.instances.find(i => i.id === pane.activeInstanceId) ?? null : null
    const payload = computeSessionIdCopyPayload(tab, inst)
    if (payload === null) return
    rDebug('settings-popover', 'copying session id(s)', { count: payload.split('\n').length })

    navigator.clipboard.writeText(payload).catch((err) => rError('settings-popover', 'copy session id failed', { error: String(err) }))
    setOpen(false)
  }

  const handleRevealConversationsFolder = () => {
    const { staticInfo } = useSessionStore.getState()
    const homeDir = staticInfo?.homePath
    if (!homeDir) return
    window.ion.fsOpenNative(`${homeDir}/.ion/conversations`).catch((err) => rDebug("settings-popover", "fsOpenNative failed", { error: String(err) }))
    setOpen(false)
  }

  // Check if debug info can be copied
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const tabs = useSessionStore((s) => s.tabs)
  const conversationPanes = useSessionStore((s) => s.conversationPanes)
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const hasDebugInfo = (() => {
    if (!activeTab) return false
    if (tabHasExtensions(activeTab)) {
      const pane = conversationPanes.get(activeTab.id)
      const inst = pane?.activeInstanceId ? pane.instances.find(i => i.id === pane.activeInstanceId) : null
      // Enable when either the live engine has reported a sessionId OR the
      // instance has persisted historical conversation IDs (restored tabs
      // before the engine reconnects, or tabs where an extension failed at
      // startup). The copy handlers already merge both sources.
      return !!(inst?.statusFields?.sessionId || (inst?.conversationIds?.length ?? 0) > 0)
    }
    // Plain conversation tabs: also check lastKnownSessionId so restored tabs with
    // historical data have the buttons enabled before reactivation.
    return !!(activeTab.conversationId || activeTab.lastKnownSessionId)
  })()

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        {...triggerIx.handlers}
        className="ion-focusable flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full"
        style={{
          color: triggerIx.hover ? colors.textSecondary : colors.textTertiary,
          background: interactiveBg(colors, triggerIx),
          transition: `background ${transitions.base}, color ${transitions.base}`,
        }}
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
            <PopoverActionRow
              icon={<ClipboardText size={14} style={{ color: colors.textTertiary }} />}
              label="Copy transcript"
              onClick={handleCopyTranscript}
            />

            <div style={{ height: 1, background: colors.popoverBorder }} />

            {/* Copy log path */}
            <PopoverActionRow
              icon={<Bug size={14} style={{ color: colors.textTertiary }} />}
              label="Copy log path"
              onClick={() => { void handleCopyDebugInfo().catch((err) => rError('settings-popover', 'copy debug info failed', { error: String(err) })) }}
              disabled={!hasDebugInfo}
              title="Copies every conversation file the engine has written for this tab. Multiple paths are newline-separated."
            />

            {/* Copy session id */}
            <PopoverActionRow
              icon={<Hash size={14} style={{ color: colors.textTertiary }} />}
              label="Copy session id"
              onClick={handleCopySessionId}
              disabled={!hasDebugInfo}
              title="Copies the session id(s) for this conversation. Multiple ids are newline-separated."
            />

            {/* Reveal conversations folder in Finder */}
            <PopoverActionRow
              icon={<FolderOpen size={14} style={{ color: colors.textTertiary }} />}
              label="Reveal conversations folder"
              onClick={handleRevealConversationsFolder}
              title="Open ~/.ion/conversations in Finder."
            />

            <div style={{ height: 1, background: colors.popoverBorder }} />

            {/* All settings */}
            <PopoverActionRow
              icon={<Gear size={14} style={{ color: colors.textTertiary }} />}
              label="Settings..."
              onClick={() => {
                setOpen(false)
                useSessionStore.getState().openSettings()
              }}
            />
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}
