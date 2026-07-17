import React, { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { anyEngineInstanceHasRunningChildren, getWaitingState } from './TabStripShared'
import { activeInstance } from '../stores/conversation-instance'
import type { TabState } from '../../shared/types'

// ─── WorkspaceStatusIndicator ───────────────────────────────────────────────
//
// A single dot mounted on the LEFT of the tab strip (immediately after the
// minimize/maximize toggle) that reflects the overall workspace running state
// at a glance. Distinct from the per-group dot: this is a quieter two-tier
// model rather than the full 9-level cascade.
//
// Tier model (global indicator — intentionally simpler than the per-tab dot):
//   orange  = any tab has foreground running (status === 'running'/'connecting')
//   yellow  = any tab has running background agents (none foreground)
//   gray    = all tabs idle
//
// Rationale for the two-tier model: the global indicator is an ambient glance
// signal, not a per-tab debugger. "Something is running" (orange) and "something
// is waiting on background agents" (yellow) are the two distinctions a user
// needs at workspace level. Finer distinctions (permission, plan-ready, bash)
// are visible on individual tab pills and group dots.
//
// Click opens a popover breakdown of per-status counts across all tabs.

/** Derive the two-tier global running state from the full tab list.
 *  Calls anyEngineInstanceHasRunningChildren for the waiting tier.
 *  Exported for unit testing (the pure folding logic, not the component). */
export function globalRunningTier(tabs: TabState[]): 'running' | 'waiting' | 'idle' {
  let hasWaiting = false
  for (const tab of tabs) {
    if (tab.status === 'running' || tab.status === 'connecting') return 'running'
    if (anyEngineInstanceHasRunningChildren(tab.id)) hasWaiting = true
  }
  return hasWaiting ? 'waiting' : 'idle'
}

/** Count tabs in each named bucket for the popover breakdown.
 *  Exported for unit testing (pure folding logic). */
export function computeStatusCounts(tabs: TabState[]): {
  running: number
  connecting: number
  waitingChildren: number
  questions: number
  planReady: number
  bash: number
  unread: number
  idle: number
  dead: number
} {
  const conversationPanes = useSessionStore.getState().conversationPanes
  const c = { running: 0, connecting: 0, waitingChildren: 0, questions: 0, planReady: 0, bash: 0, unread: 0, idle: 0, dead: 0 }
  for (const tab of tabs) {
    if (tab.isTerminalOnly) continue
    if (tab.status === 'dead' || tab.status === 'failed') { c.dead++; continue }
    if (tab.status === 'running') { c.running++; continue }
    if (tab.status === 'connecting') { c.connecting++; continue }
    if (anyEngineInstanceHasRunningChildren(tab.id)) { c.waitingChildren++; continue }
    // Check questions/plan-ready BEFORE bash/unread — matches getTabStatusColor's cascade
    // where plan-ready/question outrank bash/unread.
    const inst = activeInstance(conversationPanes, tab.id)
    const permissionQueueLength = inst?.permissionQueue.length ?? 0
    const waitingState = getWaitingState(tab, conversationPanes)
    if (permissionQueueLength > 0 || waitingState === 'question') { c.questions++; continue }
    if (waitingState === 'plan-ready') { c.planReady++; continue }
    if (tab.bashExecuting) { c.bash++; continue }
    if (tab.hasUnread) { c.unread++; continue }
    c.idle++
  }
  return c
}

export function WorkspaceStatusIndicator() {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()

  // Subscribe to tabs and running state. Also subscribe to conversationPanes
  // so running-child state changes trigger a re-render (anyEngineInstanceHas-
  // RunningChildren reads the store but is not reactive on its own; the
  // component re-renders when conversationPanes identity changes).
  const tabs = useSessionStore((s) => s.tabs)
  useSessionStore((s) => s.conversationPanes)

  const tier = globalRunningTier(tabs)

  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const dotRef = useRef<HTMLButtonElement>(null)

  const dotColor =
    tier === 'running' ? colors.statusRunning :
    tier === 'waiting' ? colors.statusWaitingChildren :
    colors.statusIdle

  const shouldPulse = tier === 'running' || tier === 'waiting'

  const handleClick = useCallback(() => {
    if (!dotRef.current) return
    const rect = dotRef.current.getBoundingClientRect()
    setPos({ top: rect.bottom + 6, left: rect.left })
    setOpen((o) => !o)
  }, [])

  // Close popover on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (dotRef.current && dotRef.current.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const counts = open ? computeStatusCounts(tabs) : null

  const popover = open && counts && popoverLayer && createPortal(
    <div
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        zIndex: 9999,
        pointerEvents: 'auto',
        background: colors.containerBg,
        border: `1px solid ${colors.tabActiveBorder}`,
        borderRadius: 8,
        padding: '10px 14px',
        minWidth: 160,
        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
        fontSize: 12,
        color: colors.textSecondary,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 11, color: colors.textTertiary, marginBottom: 8, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        Workspace
      </div>
      <WorkspaceCountRow label="Running" count={counts.running} color={colors.statusRunning} colors={colors} />
      <WorkspaceCountRow label="Connecting" count={counts.connecting} color={colors.statusRunning} colors={colors} />
      <WorkspaceCountRow label="Awaiting agents" count={counts.waitingChildren} color={colors.statusWaitingChildren} colors={colors} />
      <WorkspaceCountRow label="Question" count={counts.questions} color={colors.infoText} colors={colors} />
      <WorkspaceCountRow label="Awaiting plan" count={counts.planReady} color={colors.statusComplete} colors={colors} />
      <WorkspaceCountRow label="Bash" count={counts.bash} color={colors.statusBash} colors={colors} />
      <WorkspaceCountRow label="Unread" count={counts.unread} color={colors.statusComplete} colors={colors} />
      <WorkspaceCountRow label="Idle" count={counts.idle} color={colors.statusIdle} colors={colors} />
      {counts.dead > 0 && <WorkspaceCountRow label="Dead/failed" count={counts.dead} color={colors.statusError} colors={colors} />}
    </div>,
    popoverLayer,
  )

  return (
    <>
      <button
        ref={dotRef}
        onClick={handleClick}
        title="Workspace status"
        className="flex-shrink-0 flex items-center justify-center"
        style={{
          width: 20,
          height: 20,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          marginLeft: 6,
        }}
      >
        <span
          className={`w-[7px] h-[7px] rounded-full flex-shrink-0 ${shouldPulse ? 'animate-pulse-dot' : ''}`}
          style={{
            background: dotColor,
            display: 'block',
            ...(tier === 'waiting' ? { boxShadow: `0 0 5px 1px ${colors.statusWaitingChildrenGlow}` } : {}),
            ...(tier === 'running' ? { boxShadow: `0 0 5px 1px ${colors.statusRunning}40` } : {}),
          }}
        />
      </button>
      {popover}
    </>
  )
}

// ─── WorkspaceCountRow ────────────────────────────────────────────────────────

interface WorkspaceCountRowProps {
  label: string
  count: number
  color: string
  colors: ReturnType<typeof useColors>
}

function WorkspaceCountRow({ label, count, color, colors }: WorkspaceCountRowProps) {
  if (count === 0) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
        }}
      />
      <span style={{ flex: 1 }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: colors.textPrimary }}>{count}</span>
    </div>
  )
}
