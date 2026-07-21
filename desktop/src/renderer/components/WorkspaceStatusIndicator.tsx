import React, { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { anyEngineInstanceHasRunningChildren, getWaitingState } from './TabStripShared'
import { activeInstance } from '../stores/conversation-instance'
import { Tooltip } from './git/Tooltip'
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

/** Identity of a single tab surfaced as a clickable name in the popover. */
export interface WorkspaceTabRef {
  id: string
  title: string
}

/** Display name for a tab, mirroring TabStripTabPill's `displayTitle`
 *  (customTitle wins over title). Kept local so the fold stays pure. */
function tabDisplayTitle(tab: TabState): string {
  return tab.customTitle || tab.title
}

/** Count tabs in each named bucket for the popover breakdown, and collect the
 *  actual tab identities for the two ACTIVE-WORK buckets only: running/connecting
 *  (foreground work) and waitingChildren (background agents). Those two lists are
 *  rendered as clickable names so the user can jump straight to an actively-working
 *  tab regardless of which group buries it. Idle-ish buckets (question, plan-ready,
 *  bash, unread, idle, dead) stay count-only — they are plentiful and not "working".
 *
 *  Each identity is pushed in the exact same branch that increments its count, so
 *  the list and the count can never drift.
 *
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
  runningTabs: WorkspaceTabRef[]
  waitingTabs: WorkspaceTabRef[]
} {
  const conversationPanes = useSessionStore.getState().conversationPanes
  const c = {
    running: 0, connecting: 0, waitingChildren: 0, questions: 0, planReady: 0, bash: 0, unread: 0, idle: 0, dead: 0,
    runningTabs: [] as WorkspaceTabRef[],
    waitingTabs: [] as WorkspaceTabRef[],
  }
  for (const tab of tabs) {
    if (tab.isTerminalOnly) continue
    if (tab.status === 'dead' || tab.status === 'failed') { c.dead++; continue }
    if (tab.status === 'running') { c.running++; c.runningTabs.push({ id: tab.id, title: tabDisplayTitle(tab) }); continue }
    if (tab.status === 'connecting') { c.connecting++; c.runningTabs.push({ id: tab.id, title: tabDisplayTitle(tab) }); continue }
    if (anyEngineInstanceHasRunningChildren(tab.id)) { c.waitingChildren++; c.waitingTabs.push({ id: tab.id, title: tabDisplayTitle(tab) }); continue }
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
  // Ref on the portaled popover so the outside-click handler can exclude it.
  // The popover renders into PopoverLayer, NOT inside dotRef, so without this a
  // mousedown on an interactive row (a tab-name button) counts as "outside",
  // fires setOpen(false), unmounts the button, and the click never completes —
  // navigation silently no-ops.
  const popoverRef = useRef<HTMLDivElement>(null)

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
      if (popoverRef.current && popoverRef.current.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const counts = open ? computeStatusCounts(tabs) : null

  // Jump to a tab from the popover, then close it. selectTab is the single
  // activation path (tab-slice.ts) — same action the tab pills use — so this
  // navigates correctly no matter which group buries the tab.
  const handleNavigate = useCallback((tabId: string) => {
    useSessionStore.getState().selectTab(tabId)
    setOpen(false)
  }, [])

  const popover = open && counts && popoverLayer && createPortal(
    <div
      ref={popoverRef}
      // Marks this portaled popover as interactive UI. Without it, useClickThrough
      // (elementFromPoint().closest('[data-ion-ui]')) sees no UI under the cursor
      // and keeps the transparent overlay in OS click-through mode, so clicks on
      // the tab-name rows pass straight through to whatever app is behind the glass.
      data-ion-ui
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
      {/* Clickable names for actively-working (foreground) tabs — running + connecting.
          Only these active buckets get name lists; idle buckets stay count-only. */}
      {counts.runningTabs.map((t) => (
        <WorkspaceTabRow key={t.id} tab={t} onNavigate={handleNavigate} colors={colors} />
      ))}
      <WorkspaceCountRow label="Awaiting agents" count={counts.waitingChildren} color={colors.statusWaitingChildren} colors={colors} />
      {/* Clickable names for tabs awaiting background agents. */}
      {counts.waitingTabs.map((t) => (
        <WorkspaceTabRow key={t.id} tab={t} onNavigate={handleNavigate} colors={colors} />
      ))}
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

// ─── WorkspaceTabRow ──────────────────────────────────────────────────────────
//
// A clickable tab name nested under the Running / Awaiting-agents category.
// Clicking routes through selectTab (via onNavigate) to switch to the tab and
// close the popover. Indented under the category header; long titles truncate
// with an ellipsis and a Tooltip carries the full name (native `title` renders
// behind the Electron overlay — desktop AGENTS.md).

interface WorkspaceTabRowProps {
  tab: WorkspaceTabRef
  onNavigate: (tabId: string) => void
  colors: ReturnType<typeof useColors>
}

function WorkspaceTabRow({ tab, onNavigate, colors }: WorkspaceTabRowProps) {
  const [hover, setHover] = useState(false)
  return (
    <Tooltip text={tab.title} position="below">
      <button
        onClick={() => onNavigate(tab.id)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          gap: 6,
          marginLeft: 14,
          marginBottom: 3,
          padding: '2px 6px',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          background: hover ? colors.surfaceHover : 'transparent',
          color: hover ? colors.textPrimary : colors.textSecondary,
          fontSize: 12,
          textAlign: 'left',
        }}
      >
        <span
          style={{
            flex: 1,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {tab.title}
        </span>
      </button>
    </Tooltip>
  )
}
