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
  /** Diameter in CSS pixels. Tab pills use the default; compact status callers
   *  supply their own size without re-implementing pulse and glow behavior. */
  size?: number
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
  /** When true, the tab is waiting on background bash commands (Bash
   *  run_in_background + notify_on_complete) even though the orchestrator's
   *  own state is idle. Renders the same pink as `bashExecuting`: the dot
   *  reports that a shell is executing in this tab, not who started it. */
  hasRunningShells?: boolean
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
    //   error > permission > running > starting > running-children > bash-background >
    //   plan-ready > question > bash > unread > idle
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
      // Orange "foreground running" wins over amber "background only" —
      // see TabStripShared.getTabStatusColor for the rationale.
      bg = colors.statusRunning
      pulse = true
    } else if (props.status === 'starting') {
      // A session is attaching, not running a turn. Keep the idle dot still.
      bg = colors.statusIdle
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
    } else if (props.hasRunningShells) {
      // Pink "waiting on background shells" — orchestrator idle, background
      // bash commands still running. Mirrors the
      // anyEngineInstanceHasRunningShells branch in getTabStatusColor so
      // direct-prop callers and derived callers produce the same dot for the
      // same condition. Same color as the bashExecuting branch below: the dot
      // says a shell is executing here, not who started it.
      bg = colors.statusBash
      pulse = true
      glow = true
      glowColor = colors.statusBashGlow
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
  // Icon pills historically render at 8px while circular dots render at 6px.
  // A caller-supplied size deliberately overrides either default.
  const size = 'size' in props && props.size != null
    ? props.size
    : IconComponent ? 8 : 6
  if (IconComponent) {
    return (
      <span
        className={`flex-shrink-0 inline-flex items-center justify-center ${pulse ? 'animate-pulse-dot' : ''}`}
        style={{ width: size, height: size, ...(glow ? { filter: `drop-shadow(0 0 4px ${glowColor})` } : {}) }}
      >
        <IconComponent size={size} weight="fill" color={bg} />
      </span>
    )
  }

  return (
    <span
      className={`rounded-full flex-shrink-0 ${pulse ? 'animate-pulse-dot' : ''}`}
      style={{
        width: size,
        height: size,
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

/** One layer of a `StatusDotStack`. Structural so any caller with a resolved
 *  dot (a tab-group fold, an agent-dispatch fold) can supply it without
 *  depending on where the values came from. `glow` and `glowColor` are optional
 *  because some producers express "no glow" as an empty color rather than a
 *  flag. */
export interface StatusDotLayer {
  bg: string
  pulse: boolean
  glow?: boolean
  glowColor?: string
}

interface StatusDotStackProps {
  /** The subject in focus (foreground, on top). */
  foreground: StatusDotLayer
  /** The aggregate of everything else (background, behind). */
  background: StatusDotLayer
  /** Color of the foreground dot's separator ring — normally the surface the
   *  stack sits on, so the two layers read as distinct. */
  ringColor: string
  /** Diameter in px of each dot. Defaults to the tab-pill size. */
  size?: number
}

/**
 * Two overlapping status dots: one subject in focus, one aggregate behind it.
 *
 * Foreground dot (right / on top) carries a ring in `ringColor` so it reads
 * distinctly from the background dot it partially covers. The negative margin
 * and z-index keep the total footprint close to a single dot.
 *
 * Generic on purpose — the tab-group pill and the agent-panel row show the same
 * "focus vs. the rest" relationship, so they render through this one component
 * rather than each growing a private copy of the overlap geometry.
 */
export function StatusDotStack({ foreground, background, ringColor, size = 6 }: StatusDotStackProps) {
  const dotStyle = (layer: StatusDotLayer): React.CSSProperties => ({
    width: size,
    height: size,
    background: layer.bg,
    ...(layer.glow !== false && layer.glowColor ? { boxShadow: `0 0 6px 2px ${layer.glowColor}` } : {}),
  })
  return (
    <span className="flex-shrink-0 inline-flex items-center" style={{ position: 'relative' }}>
      {/* Background dot — the aggregate */}
      <span
        className={`rounded-full ${background.pulse ? 'animate-pulse-dot' : ''}`}
        style={{ ...dotStyle(background), position: 'relative', zIndex: 1 }}
      />
      {/* Foreground dot — the subject in focus */}
      <span
        className={`rounded-full ${foreground.pulse ? 'animate-pulse-dot' : ''}`}
        style={{
          ...dotStyle(foreground),
          marginLeft: -Math.round(size / 2),
          position: 'relative',
          zIndex: 2,
          outline: `1.5px solid ${ringColor}`,
        }}
      />
    </span>
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
 * Foreground dot: the selected tab's own status. Background dot: the aggregate
 * of all other tabs in the group. Thin wrapper over the generic
 * `StatusDotStack` — this component owns only the group-pill defaults (dot
 * size, and falling back to the active-tab color for the separator ring).
 */
export function GroupStatusDotStack({ foreground, background, pillBg }: GroupStatusDotStackProps) {
  const colors = useColors()
  return (
    <StatusDotStack
      foreground={foreground}
      background={background}
      ringColor={pillBg || colors.tabActive}
    />
  )
}
