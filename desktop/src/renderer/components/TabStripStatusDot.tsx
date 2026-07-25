import React from 'react'
import { useColors } from '../theme'
import type { TabStatus } from '../../shared/types'
import { PILL_ICON_MAP, type WaitingState } from './TabStripShared'

// ─── StatusDot ─────────────────────────────────────────────────────────────
//
// Renders the visual status dot/icon for a single tab pill in two modes:
//
//   1. Derived mode (preferred for TabStripTabPill): caller passes `derived`
//      with the output of `getTabStatusColor`. No duplicate cascade here;
//      `getTabStatusColor` is the single source of truth for the priority logic.
//
//   2. Prop mode (fallback, kept for backward-compat tests and special callers
//      that drive state as explicit booleans without a full TabState): the
//      component runs its own inline cascade. The priority order here MUST
//      mirror `getTabStatusColor` — verified by TabStripStatusDot-priority.test.tsx.
//
// TabStripTabPill uses derived mode. Any future caller that has a `TabState`
// and colors should also use derived mode by calling `getTabStatusColor` first.
//
// GroupStatusDot (group pill) uses `getGroupStatusColor` which folds
// `getTabStatusColor`, so the group dot is already single-cascade.

interface StatusDotDerived {
  /** Pre-computed dot attributes from getTabStatusColor(). When present,
   *  the prop-mode cascade below is skipped entirely. */
  derived: { bg: string; pulse: boolean; glow: boolean; glowColor: string }
  pillIcon?: string | null
}

interface StatusDotProps {
  status: TabStatus
  hasUnread: boolean
  hasPermission: boolean
  bashExecuting: boolean
  waitingState: WaitingState
  pillIcon?: string | null
  /** When true, the tab has dispatched background agents still running
   *  even though the orchestrator's own state is idle. Used by the
   *  parent-tab pill to render the yellow "awaiting children" pulse.
   *  Sits below the running/connecting branch in the priority cascade
   *  so foreground work always wins. */
  hasRunningChildren?: boolean
}

type StatusDotAllProps = StatusDotDerived | StatusDotProps

/** Single status dot/icon for one tab pill. Accepts either a pre-computed
 *  `derived` result (from `getTabStatusColor`) or explicit state props. */
export function StatusDot(props: StatusDotAllProps) {
  const colors = useColors()

  let bg: string
  let pulse: boolean
  let glow: boolean
  let glowColor: string

  if ('derived' in props) {
    // ── Derived mode: trust the pre-computed result, no duplicate cascade ──
    ;({ bg, pulse, glow, glowColor } = props.derived)
  } else {
    // ── Prop mode: inline cascade (must mirror getTabStatusColor priority) ──
    //
    // Priority order (matches TabStripShared.getTabStatusColor):
    //   error > permission > running > running-children > plan-ready >
    //   question > bash > unread > idle
    bg = colors.statusIdle
    pulse = false
    glow = false
    glowColor = colors.statusPermissionGlow

    if (props.status === 'dead' || props.status === 'failed') {
      bg = colors.statusError
    } else if (props.hasPermission) {
      bg = colors.statusPermission
      glow = true
    } else if (props.status === 'connecting' || props.status === 'running') {
      // Teal "foreground running" wins over amber "background only" —
      // see TabStripShared.getTabStatusColor for the rationale.
      bg = colors.statusRunning
      pulse = true
    } else if (props.hasRunningChildren) {
      // Yellow "awaiting children" — orchestrator idle, dispatched
      // background agents still running. Mirrors the
      // anyEngineInstanceHasRunningChildren branch in
      // getTabStatusColor so direct-prop callers and derived callers
      // produce the same dot for the same condition. Outranks plan-ready:
      // active background work is a stronger signal than a passive
      // "waiting on you" state.
      bg = colors.statusWaitingChildren
      pulse = true
      glow = true
      glowColor = colors.statusWaitingChildrenGlow
    } else if (props.waitingState === 'plan-ready') {
      bg = colors.statusComplete
      glow = true
      glowColor = colors.tabGlowPlanReady
    } else if (props.waitingState === 'question') {
      bg = colors.statusQuestion
      glow = true
      glowColor = colors.tabGlowQuestion
    } else if (props.bashExecuting) {
      bg = colors.statusBash
      pulse = true
      glow = true
      glowColor = colors.statusBashGlow
    } else if (props.hasUnread) {
      bg = colors.statusComplete
    }
  }

  const pillIcon = props.pillIcon
  const IconComponent = pillIcon ? PILL_ICON_MAP[pillIcon] : null
  if (IconComponent) {
    return (
      <span
        className={`flex-shrink-0 inline-flex items-center justify-center ${pulse ? 'animate-pulse-dot' : ''}`}
        style={{ width: 8, height: 8, ...(glow ? { filter: `drop-shadow(0 0 4px ${glowColor})` } : {}) }}
      >
        <IconComponent size={8} weight="fill" color={bg} />
      </span>
    )
  }

  return (
    <span
      className={`w-[6px] h-[6px] rounded-full flex-shrink-0 ${pulse ? 'animate-pulse-dot' : ''}`}
      style={{
        background: bg,
        ...(glow ? { boxShadow: `0 0 6px 2px ${glowColor}` } : {}),
      }}
    />
  )
}

// ─── GroupStatusDot / GroupStatusDotStack ────────────────────────────────────
//
// Two components for the group pill's status indicator:
//
//   GroupStatusDot — a single dot representing the highest-priority status
//     across all tabs in the group (for inactive groups and single-tab groups).
//     Replaces the old StackedStatusDots which rendered one dot per tab and
//     overflowed for large groups.
//
//   GroupStatusDotStack — two overlapping dots for the active multi-tab group:
//     the foreground dot shows the selected tab's own status and the background
//     dot shows the aggregate of all other tabs. This restores the ability to
//     see the selected conversation's status distinctly from the group aggregate.
//     The foreground dot is offset slightly forward (marginLeft -3) and sits at
//     a higher z-index, matching the old StackedStatusDots overlap system.
//     A thin ring on the foreground dot (outline in the active pill background
//     color) visually separates the two dots so they read as distinct layers.
//
// Color is derived via getGroupStatusColor (TabStripShared) which folds
// getTabStatusColor — the same 9-level cascade used for individual tab dots,
// ensuring parity with the per-tab surface.

interface GroupStatusDotProps {
  /** Background color from getGroupStatusColor */
  bg: string
  /** Whether the dot should pulse */
  pulse: boolean
  /** Whether to apply a glow shadow */
  glow: boolean
  /** Glow color from getGroupStatusColor */
  glowColor: string
}

/** Single consolidated status dot for a group pill. Shows the highest-priority
 *  status across all tabs in the group (error > permission > running > …). */
export function GroupStatusDot({ bg, pulse, glow, glowColor }: GroupStatusDotProps) {
  return (
    <span
      className={`w-[6px] h-[6px] rounded-full flex-shrink-0 ${pulse ? 'animate-pulse-dot' : ''}`}
      style={{
        background: bg,
        ...(glow ? { boxShadow: `0 0 6px 2px ${glowColor}` } : {}),
      }}
    />
  )
}

interface GroupStatusDotStackProps {
  /** Selected tab's own status dot (foreground, on top). */
  foreground: GroupStatusDotProps
  /** Aggregate status of all other tabs (background, behind). */
  background: GroupStatusDotProps
  /** Active pill background color — used as the foreground dot's separator ring. */
  pillBg: string
}

/**
 * Two overlapping status dots for the active multi-tab group pill.
 *
 * Foreground dot (right / on top): the selected tab's own status. Carries a
 * 1px outline in the active pill background color so it reads distinctly from
 * the background dot beneath it.
 *
 * Background dot (left / behind): the aggregate of all other tabs in the group,
 * partially obscured by the foreground dot.
 *
 * The negative margin and z-index reproduce the old StackedStatusDots overlap
 * system, keeping the total visual footprint close to a single dot.
 */
export function GroupStatusDotStack({ foreground, background, pillBg }: GroupStatusDotStackProps) {
  const colors = useColors()
  return (
    <span className="flex-shrink-0 inline-flex items-center" style={{ position: 'relative' }}>
      {/* Background dot — aggregate of other tabs */}
      <span
        className={`w-[6px] h-[6px] rounded-full ${background.pulse ? 'animate-pulse-dot' : ''}`}
        style={{
          background: background.bg,
          position: 'relative',
          zIndex: 1,
          ...(background.glow ? { boxShadow: `0 0 6px 2px ${background.glowColor}` } : {}),
        }}
      />
      {/* Foreground dot — selected tab's own status */}
      <span
        className={`w-[6px] h-[6px] rounded-full ${foreground.pulse ? 'animate-pulse-dot' : ''}`}
        style={{
          background: foreground.bg,
          marginLeft: -3,
          position: 'relative',
          zIndex: 2,
          // Ring in the active pill background color separates foreground from background.
          outline: `1.5px solid ${pillBg || colors.tabActive}`,
          ...(foreground.glow ? { boxShadow: `0 0 6px 2px ${foreground.glowColor}` } : {}),
        }}
      />
    </span>
  )
}
