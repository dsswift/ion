import React from 'react'
import { useColors } from '../theme'
import type { TabStatus } from '@ion/shared/types'
import type { WaitingState } from './conversation-status'

// ─── StatusDot ─────────────────────────────────────────────────────────────
//
// Renders the visual status dot for a single conversation in two modes:
//
//   1. Derived mode (preferred): caller passes `derived`
//      with the output of `getTabStatusColor`. No duplicate cascade here;
//      `getTabStatusColor` is the single source of truth for the priority logic.
//
//   2. Prop mode (fallback, kept for backward-compat tests and special callers
//      that drive state as explicit booleans without a full TabState): the
//      component runs its own inline cascade. The priority order here MUST
//      mirror `getTabStatusColor` — verified by StatusDot-priority.test.tsx.
//
// Any caller that has a `TabState` and colors should use derived mode by
// calling `getTabStatusColor` first.

interface StatusDotDerived {
  /** Pre-computed dot attributes from getTabStatusColor(). When present,
   *  the prop-mode cascade below is skipped entirely. */
  derived: { bg: string; pulse: boolean; glow: boolean; glowColor: string }
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
    // Priority order (matches conversation-status.getTabStatusColor):
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
      // see conversation-status.getTabStatusColor for the rationale.
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

  // A caller-supplied size overrides the 6px default.
  const size = 'size' in props && props.size != null ? props.size : 6

  return (
    <span
      className={`rounded-full flex-shrink-0 ${pulse ? 'ion-dot-live' : ''}`}
      style={{
        width: size,
        height: size,
        background: bg,
        color: bg,
        ...(glow ? { boxShadow: `0 0 6px 2px ${glowColor}` } : {}),
      }}
    />
  )
}

/** One layer of a `StatusDotStack`. Structural so any caller with a resolved
 *  dot (an agent-dispatch fold) can supply it without
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
    color: layer.bg,
    ...(layer.glow !== false && layer.glowColor ? { boxShadow: `0 0 6px 2px ${layer.glowColor}` } : {}),
  })
  return (
    <span className="flex-shrink-0 inline-flex items-center" style={{ position: 'relative' }}>
      {/* Background dot — the aggregate */}
      <span
        className={`rounded-full ${background.pulse ? 'ion-dot-live' : ''}`}
        style={{ ...dotStyle(background), position: 'relative', zIndex: 1 }}
      />
      {/* Foreground dot — the subject in focus */}
      <span
        className={`rounded-full ${foreground.pulse ? 'ion-dot-live' : ''}`}
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
