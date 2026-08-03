/**
 * event-slice-auto-fix-lifecycle — self-closing for conflict auto-fix tabs.
 *
 * An auto-fix conversation (tabRole === 'conflict-auto-fix') is an ephemeral,
 * input-locked machine conversation: its whole instruction is the one prompt
 * the conflict-assist flow submitted. When the run ends cleanly the tab has
 * served its purpose and closes itself. Every OTHER terminal shape retains the
 * tab, because a retained failure is diagnosable and a vanished one is not:
 *
 * - typed reason `max_turns`, `aborted`, `backend_exit` — the model did not
 *   finish its work; the transcript is the diagnosis surface.
 * - absent/unknown reason — an older engine or a future reason value; without
 *   proof of a normal completion the tab must not vanish.
 * - permission denials or a pending elicitation — the run stopped to ask a
 *   question nobody can answer in a locked tab; the operator must see it.
 * - `error` / `session_dead` — failures, obviously retained.
 * - running dispatched children — work is still in flight; a later terminal
 *   agent_state snapshot retries the decision.
 *
 * DECISION TIMING: called POST-COMMIT (after the reducer's set()), because the
 * task_complete reducer clears permissionQueue/elicitationQueue and rewrites
 * permissionDenied in the same set() that flips status. The caller therefore
 * captures the PRE-CLEAR denial/elicitation evidence inside the reducer and
 * hands it here, while everything else is re-read from the committed store.
 *
 * STALE-WORK REJECTION: the close decision is keyed by (tabId, runRequestId).
 * The deferred close re-reads the store and aborts when the tab is gone,
 * changed role, or started a different run — a completion signal from a killed
 * session must not close a tab that has since been reused.
 *
 * MIRROR: never decides. Tab closing is an owner action (same contract as the
 * done-move); the mirror observes the resulting tab removal through sync.
 */
import type { State } from '../session-store-types'
import { isMirrorWindow } from '../../lib/window-role'
import { rDebug, rInfo, rWarn } from '../../rendererLogger'
import { hasRunningAgents } from './event-slice-done-move'

/** Evidence captured inside the task_complete reducer before it clears state. */
export interface AutoFixCompletionEvidence {
  /** Typed completion reason from the engine; absent on older emitters. */
  reason?: string
  /** The run carried permission denials (captured pre-clear). */
  hadDenials: boolean
  /** A permission request or elicitation was pending (captured pre-clear). */
  hadPendingAsk: boolean
  /** The activeRequestId of the run this completion belongs to (pre-clear). */
  runRequestId: string | null
}

/** Delay before the close commits, so the operator sees the completed state
 *  flash rather than the tab vanishing mid-render. Also the retry window for
 *  the running-children case. */
const CLOSE_DELAY_MS = 1200

const pendingCloses = new Map<string, ReturnType<typeof setTimeout>>()

export function cancelAutoFixClose(tabId: string): void {
  const t = pendingCloses.get(tabId)
  if (t) {
    clearTimeout(t)
    pendingCloses.delete(tabId)
  }
}

/**
 * Post-commit entry point from the task_complete arm. Decides close vs retain.
 * Also called (without evidence) from the agent_state post-commit hook to
 * retry a close that was blocked by running children.
 */
export function maybeCloseAutoFixTab(
  tabId: string,
  evidence: AutoFixCompletionEvidence,
  get: () => State,
): void {
  if (isMirrorWindow()) {
    rDebug('auto-fix.lifecycle', 'skipped: mirror window', { tab_id: tabId.slice(0, 8) })
    return
  }
  const tab = get().tabs.find((t) => t.id === tabId)
  if (!tab || tab.tabRole !== 'conflict-auto-fix') return

  if (evidence.reason !== 'normal') {
    // Absent reason is indistinguishable from an abnormal end; retain. This is
    // exactly why the completion reason is a typed engine field rather than a
    // result-text heuristic: `task_complete` presence alone does not prove the
    // work finished (max-turn exhaustion also emits one).
    rInfo('auto-fix.lifecycle', 'retained: completion not typed normal', {
      tab_id: tabId.slice(0, 8), reason: evidence.reason ?? 'absent',
    })
    return
  }
  if (evidence.hadDenials || evidence.hadPendingAsk) {
    rInfo('auto-fix.lifecycle', 'retained: run ended asking for input', {
      tab_id: tabId.slice(0, 8), had_denials: evidence.hadDenials, had_pending_ask: evidence.hadPendingAsk,
    })
    return
  }
  if (hasRunningAgents(get().conversationPanes, tabId)) {
    // Children still working: do not close now. The agent_state post-commit
    // hook calls retryAutoFixCloseOnTerminalChildren when the last child
    // reaches a terminal state, which re-runs this decision.
    rInfo('auto-fix.lifecycle', 'deferred: running children', { tab_id: tabId.slice(0, 8) })
    rememberBlockedClose(tabId, evidence)
    return
  }

  scheduleClose(tabId, evidence, get)
}

/** Completions that passed every gate except running children, keyed by tab.
 *  Consulted when a terminal agent_state snapshot arrives. */
const blockedOnChildren = new Map<string, AutoFixCompletionEvidence>()

function rememberBlockedClose(tabId: string, evidence: AutoFixCompletionEvidence): void {
  blockedOnChildren.set(tabId, evidence)
}

/**
 * Post-commit entry point from the agent_state arm: when an auto-fix tab that
 * had a clean completion blocked by running children sees all children reach a
 * terminal state, retry the close decision.
 */
export function retryAutoFixCloseOnTerminalChildren(tabId: string, get: () => State): void {
  const evidence = blockedOnChildren.get(tabId)
  if (!evidence) return
  if (hasRunningAgents(get().conversationPanes, tabId)) return
  blockedOnChildren.delete(tabId)
  rInfo('auto-fix.lifecycle', 'retrying close: children now terminal', { tab_id: tabId.slice(0, 8) })
  maybeCloseAutoFixTab(tabId, evidence, get)
}

function scheduleClose(tabId: string, evidence: AutoFixCompletionEvidence, get: () => State): void {
  cancelAutoFixClose(tabId)
  const timer = setTimeout(() => {
    pendingCloses.delete(tabId)
    // Re-read the committed store: reject stale work. The tab may be gone,
    // re-roled, or running a NEW request since the completion that scheduled
    // this close.
    const now = get().tabs.find((t) => t.id === tabId)
    if (!now || now.tabRole !== 'conflict-auto-fix') {
      rDebug('auto-fix.lifecycle', 'close aborted: tab gone or re-roled', { tab_id: tabId.slice(0, 8) })
      return
    }
    if (now.status === 'running' || (now.activeRequestId && now.activeRequestId !== evidence.runRequestId)) {
      rWarn('auto-fix.lifecycle', 'close aborted: newer run in flight', {
        tab_id: tabId.slice(0, 8), status: now.status,
      })
      return
    }
    if (hasRunningAgents(get().conversationPanes, tabId)) {
      rDebug('auto-fix.lifecycle', 'close aborted: children resumed', { tab_id: tabId.slice(0, 8) })
      return
    }
    rInfo('auto-fix.lifecycle', 'closing auto-fix tab after clean completion', { tab_id: tabId.slice(0, 8) })
    get().closeTab(tabId)
  }, CLOSE_DELAY_MS)
  pendingCloses.set(tabId, timer)
}
