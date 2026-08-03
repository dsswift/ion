import React, { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ListChecks, Robot } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useAnchoredPopover } from '../hooks/useAnchoredPopover'
import { zoomViewport } from '../viewport-zoom'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { anyEngineInstanceHasRunningChildren, anyEngineInstanceHasRunningShells, getWaitingState } from './TabStripShared'
import { activeInstance, effectivePermissionMode } from '../stores/conversation-instance'
import { Tooltip } from './git/Tooltip'
import { Chevron } from './Chevron'
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
//   yellow  = any tab is waiting on background work — dispatched agents or
//             background bash commands (none foreground)
//   gray    = all tabs idle
//
// Rationale for the two-tier model: the global indicator is an ambient glance
// signal, not a per-tab debugger. "Something is running" (orange) and "something
// is waiting on background work" (yellow) are the two distinctions a user
// needs at workspace level. Finer distinctions (permission, plan-ready, which
// KIND of background work) are visible on individual tab pills, group dots,
// and the popover breakdown below.
//
// Click opens a popover breakdown of per-status counts across all tabs.

/** Derive the two-tier global running state from the full tab list.
 *  Calls anyEngineInstanceHasRunningChildren for the waiting tier.
 *  Exported for unit testing (the pure folding logic, not the component). */
export function globalRunningTier(tabs: TabState[]): 'running' | 'waiting' | 'idle' {
  let hasWaiting = false
  for (const tab of tabs) {
    if (tab.status === 'running' || tab.status === 'connecting') return 'running'
    if (anyEngineInstanceHasRunningChildren(tab.id) || anyEngineInstanceHasRunningShells(tab.id)) {
      hasWaiting = true
    }
  }
  return hasWaiting ? 'waiting' : 'idle'
}

/** Identity of a single tab surfaced as a clickable name in the popover.
 *  `mode` is the tab's authoritative permission mode (plan vs auto/build),
 *  resolved at collection time so every name row can render a glance icon
 *  showing whether the tab is planning or implementing. */
export interface WorkspaceTabRef {
  id: string
  title: string
  mode: 'plan' | 'auto'
}

/** Display name for a tab, mirroring TabStripTabPill's `displayTitle`
 *  (customTitle wins over title). Kept local so the fold stays pure. */
function tabDisplayTitle(tab: TabState): string {
  return tab.customTitle || tab.title
}

/** Count tabs in each named bucket for the popover breakdown, and collect the
 *  actual tab identities for EVERY bucket. The two ACTIVE-WORK buckets —
 *  running/connecting (foreground work) and waitingChildren (background agents)
 *  — render their names always-visible so the user can jump straight to an
 *  actively-working tab regardless of which group buries it. The idle-ish
 *  buckets (question, plan-ready, bash, unread, idle, dead) collect names too,
 *  rendered behind a collapsible header that defaults collapsed — they are
 *  plentiful and not "working", but still navigable on demand.
 *
 *  Each identity is pushed in the exact same branch that increments its count,
 *  so the list and the count can never drift.
 *
 *  Exported for unit testing (pure folding logic). */
export function computeStatusCounts(tabs: TabState[]): {
  running: number
  connecting: number
  waitingChildren: number
  waitingShells: number
  questions: number
  planReady: number
  bash: number
  unread: number
  idle: number
  dead: number
  runningTabs: WorkspaceTabRef[]
  waitingTabs: WorkspaceTabRef[]
  waitingShellTabs: WorkspaceTabRef[]
  questionTabs: WorkspaceTabRef[]
  planReadyTabs: WorkspaceTabRef[]
  bashTabs: WorkspaceTabRef[]
  unreadTabs: WorkspaceTabRef[]
  idleTabs: WorkspaceTabRef[]
  deadTabs: WorkspaceTabRef[]
} {
  const conversationPanes = useSessionStore.getState().conversationPanes
  const c = {
    running: 0, connecting: 0, waitingChildren: 0, waitingShells: 0, questions: 0, planReady: 0, bash: 0, unread: 0, idle: 0, dead: 0,
    runningTabs: [] as WorkspaceTabRef[],
    waitingTabs: [] as WorkspaceTabRef[],
    waitingShellTabs: [] as WorkspaceTabRef[],
    questionTabs: [] as WorkspaceTabRef[],
    planReadyTabs: [] as WorkspaceTabRef[],
    bashTabs: [] as WorkspaceTabRef[],
    unreadTabs: [] as WorkspaceTabRef[],
    idleTabs: [] as WorkspaceTabRef[],
    deadTabs: [] as WorkspaceTabRef[],
  }
  /** Build the clickable ref for a tab, resolving its plan/build mode through
   *  the single authoritative seam (effectivePermissionMode — same resolver
   *  the status-bar mode picker reads). */
  const ref = (tab: TabState): WorkspaceTabRef => ({
    id: tab.id,
    title: tabDisplayTitle(tab),
    mode: effectivePermissionMode(tab, conversationPanes),
  })
  for (const tab of tabs) {
    if (tab.isTerminalOnly) continue
    if (tab.status === 'dead' || tab.status === 'failed') { c.dead++; c.deadTabs.push(ref(tab)); continue }
    if (tab.status === 'running') { c.running++; c.runningTabs.push(ref(tab)); continue }
    if (tab.status === 'connecting') { c.connecting++; c.runningTabs.push(ref(tab)); continue }
    if (anyEngineInstanceHasRunningChildren(tab.id)) { c.waitingChildren++; c.waitingTabs.push(ref(tab)); continue }
    // Background bash commands the session is holding for. Ranked directly
    // after agents, matching getTabStatusColor's cascade.
    if (anyEngineInstanceHasRunningShells(tab.id)) { c.waitingShells++; c.waitingShellTabs.push(ref(tab)); continue }
    // Check questions/plan-ready BEFORE bash/unread — matches getTabStatusColor's cascade
    // where plan-ready/question outrank bash/unread.
    const inst = activeInstance(conversationPanes, tab.id)
    const permissionQueueLength = inst?.permissionQueue.length ?? 0
    const waitingState = getWaitingState(tab, conversationPanes)
    if (permissionQueueLength > 0 || waitingState === 'question') { c.questions++; c.questionTabs.push(ref(tab)); continue }
    if (waitingState === 'plan-ready') { c.planReady++; c.planReadyTabs.push(ref(tab)); continue }
    if (tab.bashExecuting) { c.bash++; c.bashTabs.push(ref(tab)); continue }
    if (tab.hasUnread) { c.unread++; c.unreadTabs.push(ref(tab)); continue }
    c.idle++; c.idleTabs.push(ref(tab))
  }
  return c
}

// ─── Sticky category expansion (process-scoped) ──────────────────────────────
//
// The idle-ish categories are collapsed by default; when the user expands one,
// the expansion must survive closing and reopening the popover — but reset on
// app quit. Module scope gives exactly that lifetime: it outlives component
// unmounts (popover close, TabStrip remount) and dies with the renderer
// process. No persistence, no store slice, no IPC. Each window (overlay, ATV)
// gets its own module instance, so expansion is per-window — acceptable for a
// glance affordance, not synced state.

export type WorkspaceCategoryId = 'question' | 'plan-ready' | 'bash' | 'unread' | 'idle' | 'dead'

const expandedCategories = new Set<WorkspaceCategoryId>()

/** Test seam: clear sticky expansion so test cases stay order-independent. */
export function resetWorkspaceCategoryExpansion(): void {
  expandedCategories.clear()
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
  // The trigger's own rect, captured on click. The measured on-screen position
  // is derived from it by `useAnchoredPopover` below.
  const [anchor, setAnchor] = useState({ x: 0, y: 0 })
  // Version counter re-rendering the popover when the module-level expansion
  // Set mutates (the Set itself is not reactive).
  const [expansionVersion, setExpansionVersion] = useState(0)
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
    setAnchor({ x: rect.left, y: rect.bottom })
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

  // Measured placement. The dot lives in the tab strip, which sits at the
  // BOTTOM of the overlay glass and at the TOP of the ATV window, so a fixed
  // "below the dot" placement is off-screen in one of the two. The popover
  // grows with the tab list, so the counts drive a re-measure.
  const pos = useAnchoredPopover(anchor, {
    offsetY: 6,
    // Every input that changes the popover's rendered height: whether it is
    // open at all, how many tab rows the categories list, and which categories
    // the operator has expanded.
    deps: [open, tabs.length, expansionVersion],
  })
  const vp = zoomViewport()

  // Jump to a tab from the popover, then close it. selectTab is the single
  // activation path (tab-slice.ts) — same action the tab pills use — so this
  // navigates correctly no matter which group buries the tab.
  const handleNavigate = useCallback((tabId: string) => {
    useSessionStore.getState().selectTab(tabId)
    setOpen(false)
  }, [])

  // Toggle an idle-ish category's expansion. Mutates the module-level Set
  // (sticky for the process) and bumps the version counter to re-render.
  const handleToggleCategory = useCallback((id: WorkspaceCategoryId) => {
    if (expandedCategories.has(id)) expandedCategories.delete(id)
    else expandedCategories.add(id)
    setExpansionVersion((v) => v + 1)
  }, [])

  const popover = open && counts && popoverLayer && createPortal(
    <div
      ref={(node) => { (popoverRef as React.MutableRefObject<HTMLDivElement | null>).current = node; pos.ref(node) }}
      // Marks this portaled popover as interactive UI. Without it, useClickThrough
      // (elementFromPoint().closest('[data-ion-ui]')) sees no UI under the cursor
      // and keeps the transparent overlay in OS click-through mode, so clicks on
      // the tab-name rows pass straight through to whatever app is behind the glass.
      data-ion-ui
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        visibility: pos.ready ? 'visible' : 'hidden',
        maxHeight: vp.height - 16,
        overflowY: 'auto',
        zIndex: 9999,
        pointerEvents: 'auto',
        background: colors.containerBg,
        border: `1px solid ${colors.tabActiveBorder}`,
        borderRadius: 8,
        padding: '10px 14px',
        minWidth: 160,
        boxShadow: colors.popoverShadow,
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
          Active buckets stay always-expanded: they are the "working now" signal. */}
      {counts.runningTabs.map((t) => (
        <WorkspaceTabRow key={t.id} tab={t} onNavigate={handleNavigate} colors={colors} />
      ))}
      <WorkspaceCountRow label="Awaiting agents" count={counts.waitingChildren} color={colors.statusWaitingChildren} colors={colors} />
      {/* Clickable names for tabs awaiting background agents. */}
      {counts.waitingTabs.map((t) => (
        <WorkspaceTabRow key={t.id} tab={t} onNavigate={handleNavigate} colors={colors} />
      ))}
      <WorkspaceCountRow label="Awaiting shells" count={counts.waitingShells} color={colors.statusBash} colors={colors} />
      {/* Clickable names for tabs awaiting background bash commands. */}
      {counts.waitingShellTabs.map((t) => (
        <WorkspaceTabRow key={t.id} tab={t} onNavigate={handleNavigate} colors={colors} />
      ))}
      {/* Idle-ish buckets: collapsible, collapsed by default, expansion sticky
          for the process (module-level Set above). Rows with count 0 render null. */}
      <WorkspaceCollapsibleRow categoryId="question" label="Question" count={counts.questions} color={colors.statusQuestion} colors={colors} tabs={counts.questionTabs} onToggle={handleToggleCategory} onNavigate={handleNavigate} />
      <WorkspaceCollapsibleRow categoryId="plan-ready" label="Awaiting plan" count={counts.planReady} color={colors.statusComplete} colors={colors} tabs={counts.planReadyTabs} onToggle={handleToggleCategory} onNavigate={handleNavigate} />
      <WorkspaceCollapsibleRow categoryId="bash" label="Bash" count={counts.bash} color={colors.statusBash} colors={colors} tabs={counts.bashTabs} onToggle={handleToggleCategory} onNavigate={handleNavigate} />
      <WorkspaceCollapsibleRow categoryId="unread" label="Unread" count={counts.unread} color={colors.statusComplete} colors={colors} tabs={counts.unreadTabs} onToggle={handleToggleCategory} onNavigate={handleNavigate} />
      <WorkspaceCollapsibleRow categoryId="idle" label="Idle" count={counts.idle} color={colors.statusIdle} colors={colors} tabs={counts.idleTabs} onToggle={handleToggleCategory} onNavigate={handleNavigate} />
      <WorkspaceCollapsibleRow categoryId="dead" label="Dead/failed" count={counts.dead} color={colors.statusError} colors={colors} tabs={counts.deadTabs} onToggle={handleToggleCategory} onNavigate={handleNavigate} />
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

// ─── WorkspaceCollapsibleRow ──────────────────────────────────────────────────
//
// A count row for an idle-ish bucket that discloses its tab names on demand.
// The whole header is a button toggling the category in the module-level
// expansion Set; the Chevron (repo-standard disclosure glyph) rotates with
// state. Expanded categories render their tabs with the same WorkspaceTabRow
// the active buckets use, so navigation behaves identically everywhere.

interface WorkspaceCollapsibleRowProps {
  categoryId: WorkspaceCategoryId
  label: string
  count: number
  color: string
  colors: ReturnType<typeof useColors>
  tabs: WorkspaceTabRef[]
  onToggle: (id: WorkspaceCategoryId) => void
  onNavigate: (tabId: string) => void
}

function WorkspaceCollapsibleRow({ categoryId, label, count, color, colors, tabs, onToggle, onNavigate }: WorkspaceCollapsibleRowProps) {
  const [hover, setHover] = useState(false)
  if (count === 0) return null
  const expanded = expandedCategories.has(categoryId)
  return (
    <div style={{ marginBottom: 4 }}>
      <button
        onClick={() => onToggle(categoryId)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        aria-expanded={expanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          gap: 8,
          padding: '1px 2px',
          border: 'none',
          borderRadius: 4,
          cursor: 'pointer',
          background: hover ? colors.surfaceHover : 'transparent',
          color: colors.textSecondary,
          fontSize: 12,
          textAlign: 'left',
        }}
      >
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
        <Chevron open={expanded} color={colors.textTertiary} />
      </button>
      {expanded && tabs.map((t) => (
        <WorkspaceTabRow key={t.id} tab={t} onNavigate={onNavigate} colors={colors} />
      ))}
    </div>
  )
}

// ─── WorkspaceTabRow ──────────────────────────────────────────────────────────
//
// A clickable tab name nested under a category. Clicking routes through
// selectTab (via onNavigate) to switch to the tab and close the popover.
// Indented under the category header; long titles truncate with an ellipsis
// and a Tooltip carries the full name (native `title` renders behind the
// Electron overlay — desktop AGENTS.md). A leading glyph shows the tab's
// permission mode at a glance: ListChecks = plan mode (same glyph the
// status-bar mode picker uses for Plan), Robot = build/auto mode (matches the
// repo's agent/AI iconography).

interface WorkspaceTabRowProps {
  tab: WorkspaceTabRef
  onNavigate: (tabId: string) => void
  colors: ReturnType<typeof useColors>
}

function WorkspaceTabRow({ tab, onNavigate, colors }: WorkspaceTabRowProps) {
  const [hover, setHover] = useState(false)
  return (
    <div style={{ display: 'block', width: '100%' }}>
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
          {/* Mode glyph — plan vs build. Same color pair as the status-bar
              mode picker (modeAcceptEdits for plan, textTertiary for auto). */}
          <span aria-hidden style={{ display: 'inline-flex', flexShrink: 0 }} data-mode={tab.mode}>
            {tab.mode === 'plan'
              ? <ListChecks size={11} weight="bold" color={colors.modeAcceptEdits} />
              : <Robot size={11} weight="fill" color={colors.textTertiary} />}
          </span>
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
    </div>
  )
}
