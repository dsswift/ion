import React from 'react'
import { useShallow } from 'zustand/shallow'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { useActiveEngineAgentRunningCount, useActiveEngineBackgroundShellCount, useActiveEngineHeldShellCount, useActiveEngineStatusFields } from './StatusBarEngineHelpers'

/**
 * Engine state slot — renders the orchestrator run-activity dot + label in
 * the unified `StatusBar` left cluster.
 *
 * Visual states, in priority order:
 *   - orchestrator running (`tab.status === 'running' | 'connecting'`) →
 *       orange `statusRunning` pulse + `[running]`, with live background shell
 *       count appended when present
 *   - orchestrator NOT running AND agentRunningCount > 0 →
 *       yellow `statusWaitingChildren` pulse +
 *       `[waiting for N agent(s)]`
 *   - orchestrator NOT running AND agentRunningCount === 0 AND
 *     shellRunningCount > 0 →
 *       pink `statusBash` pulse + `[waiting for N background shell(s)]` when
 *       the engine is holding for them, or `[N background shell(s) running]`
 *       when every live command is detached
 *   - orchestrator NOT running AND no agents/shells but the engine's generic
 *     `hasPendingWork` flag is set (queued prompts, dispatch completions, a
 *     parked run) →
 *       yellow `statusWaitingChildren` pulse + `[waiting for queued work]`
 *   - everything else → renders nothing (this is a run-activity indicator;
 *       there is no idle label).
 *
 * SOURCE OF TRUTH: this slot reads `tab.status` for the orchestrator's own
 * run-state, the per-instance agent-state fold for dispatched work, and
 * `liveBackgroundShellCount` (shared/background-shell-counts.ts) for background
 * Bash processes. `hasPendingWork` is the generic fallback when no specific
 * count explains the wait. All signals come from the active conversation
 * instance.
 *
 * WHY THE LIVE COUNT, NOT `backgroundShells`: the engine's `backgroundShells`
 * scalar counts only commands started with `notify_on_complete`, because those
 * are the ones it parks the session on. A detached `run_in_background` command
 * is still a live process doing real work. Reading the held count here made
 * this slot go blank while a 96-second detached command ran — the operator saw
 * the pink Bash operation group spinning and no composer badge at all. The
 * live count fixes the presence of the badge; the held count still decides the
 * WORDING, because "waiting for" is a false claim about a detached command.
 *
 * TAB-TYPE-AGNOSTIC: the `Agent` tool dispatches sub-agents
 * regardless of whether a harness is loaded, so a plain conversation can have
 * running children too. Both signals here are tab-type-agnostic, matching the
 * tab-pill yellow dot (`anyEngineInstanceHasRunningChildren`) and the close
 * guard that blocks closing any tab with running children.
 *
 * WORDING: the agent label says "agent(s)", not "background agent(s)". Agent
 * dispatch is asynchronous by default, but the count describes agents rather
 * than the scheduling mode. The shell label is different and deliberately says
 * "background shell(s)": those are detached processes that can outlive the
 * turn that started them.
 *
 * PRIORITY: agents outrank shells, and shells outrank the generic pending
 * flag. `hasPendingWork` (engine/internal/session/status_work_snapshot.go)
 * is a catch-all that is also true whenever a NOTIFYING background shell is
 * outstanding, so it must be the LAST resort, not folded into the agent
 * check — otherwise a session with only a running shell (no agents) renders
 * the vague "waiting for queued work" instead of the specific shell count,
 * even though the richer signal (shellRunningCount) is available. This was a
 * real regression: `isWaitingChildren` used to OR in `hasPendingWork`
 * directly, which made it true the instant a shell registered and stole the
 * render from the shell branch below it.
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
  const heldShellCount = useActiveEngineHeldShellCount()
  const statusFields = useActiveEngineStatusFields()

  const isRun = status === 'running' || status === 'connecting'
  const isWaitingChildren = !isRun && agentRunningCount > 0
  // Background shells rank below agents, matching the tab-dot cascade: when
  // both are outstanding the richer agent signal is the one worth surfacing in
  // this single-line slot.
  const isWaitingShells = !isRun && !isWaitingChildren && shellRunningCount > 0
  // Lowest priority: the engine's generic hasPendingWork catch-all (queued
  // prompts, dispatch completions, a parked run) only surfaces when neither
  // of the more specific signals above already explained the wait.
  const isWaitingPending = !isRun && !isWaitingChildren && !isWaitingShells
    && (status === 'waiting' || statusFields?.hasPendingWork === true)

  if (!isRun && !isWaitingChildren && !isWaitingShells && !isWaitingPending) return null

  const stateColor = isRun
    ? colors.statusRunning
    : isWaitingChildren || isWaitingPending
      ? colors.statusWaitingChildren
      : colors.statusBash
  const dotColor = stateColor
  const labelColor = stateColor
  const label = isRun
    ? shellRunningCount > 0
      ? `running · ${shellRunningCount} background shell${shellRunningCount === 1 ? '' : 's'}`
      : 'running'
    : isWaitingChildren
      ? `waiting for ${agentRunningCount} agent${agentRunningCount === 1 ? '' : 's'}`
      : isWaitingShells
        // "background shell" IS accurate here, unlike the agent label above: these
        // are shell processes running detached from any turn. Do not "align" this
        // wording with the agent label.
        //
        // "waiting for" is only true when the engine actually parked the session
        // on the command (notify_on_complete). When every live command is
        // detached the engine is NOT waiting — it went idle and left the process
        // running — so the label states the fact instead of inventing a wait.
        ? heldShellCount > 0
          ? `waiting for ${shellRunningCount} background shell${shellRunningCount === 1 ? '' : 's'}`
          : `${shellRunningCount} background shell${shellRunningCount === 1 ? '' : 's'} running`
        : 'waiting for queued work'

  return (
    <span
      data-testid="composer-activity-status"
      style={{ color: colors.textTertiary, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10 }}
    >
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
