/**
 * Close guard for the remote (iOS) close path.
 *
 * The desktop hard-blocks Cmd+W while a tab has work in flight —
 * `evaluateSessionBusyGuard` in the renderer store (session-busy-guard.ts) refuses the
 * close when the orchestrator is running, a dispatched agent is running, or a
 * background bash command is outstanding. Closing anyway kills the engine
 * session and orphans that work.
 *
 * iOS `closeTab` had no such rule, so the same tab the desktop refuses to close
 * could be closed from the phone. The asymmetry predates the background-shell
 * dimension for agents, but adding shells to the desktop guard widened it, so
 * it is closed here rather than left as one client enforcing a rule the other
 * does not.
 *
 * The renderer's guard reads `conversationPanes`, which the main process does
 * not hold. It does hold `state.rendererSnapshotCache` — the projection the
 * owner renderer pushes, and the same cache the iOS snapshot is served from —
 * and those tabs carry every signal the guard needs: per-instance `isRunning`,
 * `runningAgentCount`, and `backgroundShellCount`.
 *
 * The cache is read directly rather than through `getRemoteTabStates()`: that
 * function builds a full snapshot (disk reads for resource metadata, an engine
 * health check, a renderer poll on a cache miss), which is far too much work to
 * do on a close, and it made the close path fail in any context without a fully
 * wired session plane. A cache miss here means "no projection yet", which the
 * unknown-tab rule below already handles correctly.
 *
 * Kept pure and separate from handlers/tabs.ts so it is unit-testable without
 * an Electron window, matching how session-busy-guard.ts is tested on the
 * renderer side.
 */

import type { ProjectedRendererTab } from '../../../shared/remote-projection-types'

export interface RemoteCloseGuardResult {
  /** True when the tab has work in flight and must not be closed. */
  blocked: boolean
  /** The orchestrator itself is mid-run on at least one instance. */
  orchestratorRunning: boolean
  /** Summed running dispatched agents across instances. */
  agentCount: number
  /** Summed outstanding background bash commands across instances. */
  shellCount: number
}

/**
 * Evaluate the close guard against a projected tab.
 *
 * An absent tab is NOT blocked: the projection may not have caught up (or the
 * tab is already gone), and refusing a close for a tab we cannot see would
 * strand the user with an uncloseable row on the phone. The desktop guard makes
 * the same choice for a missing pane.
 *
 * Fields are optional in the projection and omitted at zero, so every read
 * defaults to 0/false — a tab projected by an older desktop build simply
 * reports no work in flight rather than throwing.
 */
export function evaluateRemoteCloseGuard(
  tab: ProjectedRendererTab | null | undefined,
): RemoteCloseGuardResult {
  if (!tab) {
    return { blocked: false, orchestratorRunning: false, agentCount: 0, shellCount: 0 }
  }

  let orchestratorRunning = false
  let agentCount = 0
  let shellCount = 0

  // Tab-level status covers the plain single-instance case, where the
  // orchestrator's run state rides the tab rather than an instance entry.
  if (tab.status === 'running' || tab.status === 'connecting' || tab.status === 'waiting') {
    orchestratorRunning = true
  }

  for (const inst of tab.conversationInstances ?? []) {
    if (inst.isRunning) orchestratorRunning = true
    agentCount += inst.runningAgentCount ?? 0
    shellCount += inst.backgroundShellCount ?? 0
  }

  return {
    blocked: orchestratorRunning || agentCount > 0 || shellCount > 0,
    orchestratorRunning,
    agentCount,
    shellCount,
  }
}

/** Single-line refusal for the log, mirroring formatSessionBusyRefusal. */
export function formatRemoteCloseGuardRefusal(
  tabId: string,
  result: RemoteCloseGuardResult,
): Record<string, unknown> {
  return {
    tab_id: tabId.slice(0, 8),
    orchestrator_running: result.orchestratorRunning,
    agent_count: result.agentCount,
    background_shells: result.shellCount,
  }
}
