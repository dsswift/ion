import React from 'react'
import { useShallow } from 'zustand/shallow'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { useActiveEngineAgentRunningCount, useActiveEngineBackgroundShellCount } from './StatusBarEngineHelpers'

/**
 * Engine state slot — renders the orchestrator run-activity dot + label in
 * the unified `StatusBar` left cluster.
 *
 * Two visual states (priority order):
 *   - orchestrator running (`tab.status === 'running' | 'connecting'`) →
 *       orange `statusRunning` pulse + `[running]`
 *   - orchestrator NOT running AND agentRunningCount > 0 →
 *       yellow `statusWaitingChildren` pulse +
 *       `[waiting for N agent(s)]`
 *   - everything else → renders nothing (this is a run-activity indicator;
 *       there is no idle label).
 *
 * SOURCE OF TRUTH: this slot reads the two signals that are actually
 * populated in the renderer — `tab.status` for the orchestrator's own
 * run-state (the same signal the tab pill, model picker, and directory
 * picker read) and `useActiveEngineAgentRunningCount()` for the dispatched
 * agent count. It does NOT read `inst.statusFields`: that field
 * is never populated in the renderer (it exists only for the main-process
 * iOS snapshot projection), so gating on it suppressed this slot entirely.
 *
 * TAB-TYPE-AGNOSTIC: the `Agent` tool dispatches sub-agents
 * regardless of whether a harness is loaded, so a plain conversation can have
 * running children too. Both signals here are tab-type-agnostic, matching the
 * tab-pill yellow dot (`anyEngineInstanceHasRunningChildren`) and the close
 * guard that blocks closing any tab with running children.
 *
 * WORDING: the agent label says "agent(s)", not "background agent(s)". The
 * Agent tool dispatches children FOREGROUND (the dispatch blocks the parent's
 * tool call until the child completes), so calling them "background" was wrong.
 * The count is the number of running dispatched-agent pills on the active
 * instance, foreground or background alike.
 *
 * The SHELL label is different and deliberately says "background shell(s)":
 * those are genuinely detached processes that outlive the turn that started
 * them, and the session is held open waiting for them. The two labels are
 * inconsistent on purpose — do not "fix" one to match the other.
 *
 * Foreground orange beats background yellow because the orchestrator's
 * own activity is the strongest signal — matches the priority cascade
 * in `TabStripShared.getTabStatusColor`. The pulse animation reuses
 * `.animate-pulse-dot`, only the background color differs between the two
 * pulsing branches.
 */
export function StatusBarEngineState() {
  const colors = useColors()
  const status = useSessionStore(
    useShallow((s) => s.tabs.find((t) => t.id === s.activeTabId)?.status ?? null),
  )
  const agentRunningCount = useActiveEngineAgentRunningCount()
  const shellRunningCount = useActiveEngineBackgroundShellCount()

  const isRun = status === 'running' || status === 'connecting'
  const isWaitingChildren = !isRun && agentRunningCount > 0
  // Background shells rank below agents, matching the tab-dot cascade: when
  // both are outstanding the richer agent signal is the one worth surfacing in
  // this single-line slot.
  const isWaitingShells = !isRun && !isWaitingChildren && shellRunningCount > 0

  if (!isRun && !isWaitingChildren && !isWaitingShells) return null

  const stateColor = isRun
    ? colors.statusRunning
    : isWaitingChildren
      ? colors.statusWaitingChildren
      : colors.statusBash
  const dotColor = stateColor
  const labelColor = stateColor
  const label = isRun
    ? 'running'
    : isWaitingChildren
      ? `waiting for ${agentRunningCount} agent${agentRunningCount === 1 ? '' : 's'}`
      // "background shell" IS accurate here, unlike the agent label above: these
      // are shell processes running detached from any turn, and the session is
      // held open for them. Do not "align" this wording with the agent label.
      : `waiting for ${shellRunningCount} background shell${shellRunningCount === 1 ? '' : 's'}`

  return (
    <span style={{ color: colors.textTertiary, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
      <span
        className="animate-pulse-dot"
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: dotColor,
          display: 'inline-block',
          flexShrink: 0,
        }}
      />
      <span style={{ color: labelColor }}>[{label}]</span>
    </span>
  )
}
