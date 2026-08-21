/**
 * setTabStatus — the single canonical seam for tab status transitions.
 *
 * All renderer write sites that set tab.status on the tabs array route
 * through this helper. Centralizing the mutation makes the full set of valid
 * transitions auditable in one place and gives every writer a uniform guard
 * contract.
 *
 * ## Usage
 *
 * Without guard (unconditional):
 *   `tabs = setTabStatus(tabs, tabId, 'connecting', 'engine.add-instance')`
 *
 * With guard (conditional):
 *   `tabs = setTabStatus(tabs, tabId, 'idle', 'engine.start-settled', (t) => t.status === 'connecting')`
 *
 * ## Guards
 *
 * The guard predicate receives the current `TabState` and returns true only
 * when the transition should fire. Use guards for "only idle from connecting,
 * never from running" constraints so a late engine event can't knock a live
 * tab back to idle.
 *
 * ## Every call is logged, including the ones that change nothing
 *
 * `source` is REQUIRED and names the calling site. It is not decoration: a tab
 * stuck in a status is diagnosable only by knowing which of the call sites
 * wrote it and which of them tried and were refused. Both halves matter — a
 * transition that never fired because a guard rejected it, or because the tab
 * was already at the target, is exactly as interesting as one that did, and a
 * silent no-op is what makes a stuck status unexplainable after the fact.
 * Every outcome is therefore logged with its source, its from/to pair, and the
 * window that wrote it (see below). Making the parameter required means the
 * compiler, not review, is what stops a new unattributed write site landing.
 *
 * ## Both windows write, and the log must say which
 *
 * The overlay and the Studio shell each run a copy of this store (the mirror
 * architecture — see ADR-021), so both execute this function against their own
 * `tabs` array. Two windows disagreeing about one conversation's status is a
 * real and observed failure mode, and a log line that omits the window cannot
 * distinguish "one window is wrong" from "both are". `window_role` is on every
 * line for that reason.
 *
 * ## What this does NOT cover
 *
 * This helper owns writes to the `tabs` ARRAY. Several paths instead write
 * `status` onto a per-event mutation object or inside their own `map`, so they
 * cannot route through here:
 *
 *   - `ctx.updated.status = '...'` in event-slice-task.ts and
 *     event-slice-extension-surface.ts (the TaskCtx mutation system)
 *   - the `session_init` promotion in event-slice.ts
 *   - the send paths in send-slice.ts, which build a whole new tab object
 *   - permissions-slice.ts and useHealthReconciliation.ts
 *
 * Those sites log through `logTabStatusWrite` below, so the union of this
 * helper's lines and theirs is the complete record of renderer status writes.
 * A status write with no log line in one of those two shapes is a defect.
 *
 * The `clearConnectingStatus` helper in prompt-pipeline-renderer.ts uses
 * `executeJavaScript` with an inline store mutation — it cannot import this
 * renderer helper across the main↔renderer process boundary. That is an
 * intentional cross-process constraint; the inline map there is the correct
 * approach.
 *
 * ## iOS parity
 *
 * iOS has 8 parallel write sites across 4 ViewModel files. A Swift equivalent
 * (`setTabStatus` in Swift) would mirror this pattern. The iOS writes currently
 * work correctly — this is latent-risk prevention for the desktop side.
 */

import type { TabState, TabStatus } from '../../../shared/types'
import { windowRole } from '../../lib/window-role'
import { rInfo } from '../../rendererLogger'

/**
 * Names the code path performing a status write. Required by `setTabStatus` and
 * `logTabStatusWrite` so every line in `desktop.jsonl` attributes itself.
 *
 * A union rather than a bare string: the value is what an operator greps for
 * when a conversation is stuck, so a typo silently producing an unsearchable
 * tag defeats the point. Adding a write site means adding its name here, which
 * keeps this list an accurate census of everything that can move a status.
 */
export type TabStatusSource =
  // setTabStatus call sites (writes to the tabs array)
  | 'engine.add-instance'
  | 'engine.start-failed'
  | 'engine.start-online'
  | 'engine.start-threw'
  | 'engine.create-connecting'
  | 'engine.create-online'
  | 'implement.plan'
  | 'event.status-resync'
  // sites that write status outside the tabs array (logTabStatusWrite)
  | 'event.status-transition'
  | 'event.session-init'
  | 'event.task-complete'
  | 'event.task-failed'
  | 'event.task-dead'
  | 'event.extension-surface-idle'
  | 'event.extension-surface-failed'
  | 'send.submit'
  | 'send.remote'
  | 'permissions.force-recover'
  | 'health.reconcile'

/** Outcome of an attempted status write. Every attempt reports one of these. */
export type TabStatusOutcome =
  /** The status changed. */
  | 'applied'
  /** The guard predicate refused the transition. */
  | 'guard-rejected'
  /** The tab was already at the target status. */
  | 'already-at-target'
  /** No tab with that id exists in this window's store. */
  | 'tab-missing'

/**
 * Emit the canonical status-write line. Shared by `setTabStatus` and by the
 * write sites that cannot route through it, so both produce the identical shape
 * and one `jq` filter covers every status write in the renderer:
 *
 *   jq -c 'select(.tag=="tab.status")' ~/.ion/desktop.jsonl
 *
 * INFO rather than DEBUG deliberately. Status transitions are low-frequency
 * (a handful per run, not per token) and they are the first thing anyone needs
 * when a conversation misreports what it is doing, so they must be present in
 * a default-level log rather than behind a verbosity flag.
 *
 * Prefer `logTabStatusPatch` for a direct write: it derives the outcome instead
 * of trusting the caller to state it. Call this one only when the outcome is
 * genuinely known to the caller and cannot be derived from the pair (the
 * tab-missing and guard-rejected cases).
 */
export function logTabStatusWrite(
  tabId: string,
  from: TabStatus | 'unknown',
  to: TabStatus,
  source: TabStatusSource,
  outcome: TabStatusOutcome,
  extra?: Record<string, unknown>,
): void {
  rInfo('tab.status', 'status write', {
    tab_id: tabId.slice(0, 8),
    from,
    to,
    source,
    outcome,
    window_role: windowRole(),
    ...extra,
  })
}

/**
 * Log a direct status write — one that builds its own tab object or mutates a
 * patch, rather than calling `setTabStatus` — and DERIVE the outcome from the
 * from/to pair.
 *
 * Deriving is the point. Every one of these sites previously passed a literal
 * `'applied'`, which made the log assert a change on writes that changed
 * nothing: a heartbeat re-asserting `connecting -> connecting` was recorded
 * identically to a real transition. That is precisely the class of inaccuracy
 * this instrumentation exists to remove — a status trail is only useful if
 * "applied" means the status actually moved. `setTabStatus` already reports
 * `already-at-target` for the same case, so a hand-written `'applied'` also put
 * the two halves of the log into disagreement.
 *
 * Side effects that accompany a no-op write (a cleared permission queue, for
 * instance) belong in `extra`, not in the outcome: the outcome describes the
 * STATUS, and a write can legitimately do other work while leaving it alone.
 */
export function logTabStatusPatch(
  tabId: string,
  from: TabStatus,
  to: TabStatus,
  source: TabStatusSource,
  extra?: Record<string, unknown>,
): void {
  logTabStatusWrite(tabId, from, to, source, from === to ? 'already-at-target' : 'applied', extra)
}

/**
 * Apply a tab status transition to the tabs array. Returns a new array when
 * the transition fires, or the SAME reference when the tab is not found, the
 * guard rejects the transition, or the tab is already in the target status.
 *
 * The same-reference short-circuit on no-op prevents spurious re-renders: if
 * the tab is already `idle` and we call `setTabStatus(tabs, id, 'idle')`, the
 * returned reference is `===` to the input and Zustand's shallow-equality
 * check sees no change.
 *
 * @param tabs    Current tab array from store state.
 * @param tabId   The tab to transition.
 * @param status  The target status.
 * @param source  Which call site is writing. Logged on every outcome.
 * @param guard   Optional predicate — transition fires only when guard(tab)
 *                returns true. When omitted, the transition is unconditional.
 */
export function setTabStatus(
  tabs: TabState[],
  tabId: string,
  status: TabStatus,
  source: TabStatusSource,
  guard?: (t: TabState) => boolean,
): TabState[] {
  const idx = tabs.findIndex((t) => t.id === tabId)
  if (idx === -1) {
    // Not silent: a write aimed at a tab this window does not have is how a
    // mirror/owner divergence first shows up, and it would otherwise vanish.
    logTabStatusWrite(tabId, 'unknown', status, source, 'tab-missing')
    return tabs
  }
  const tab = tabs[idx]
  if (guard && !guard(tab)) {
    logTabStatusWrite(tabId, tab.status, status, source, 'guard-rejected')
    return tabs
  }
  if (tab.status === status) {
    logTabStatusWrite(tabId, tab.status, status, source, 'already-at-target')
    return tabs
  }
  const next = tabs.slice()
  // running→idle stamps idleSince: the renderer observes the same
  // transition the engine would timestamp (SessionStatus.stateSince is a
  // dead engine field — never assigned engine-side; when the engine's
  // Phase-5 state machine populates it, the nonzero engine value takes
  // precedence upstream). A restore never re-stamps: only this live
  // transition path writes the field.
  const cameToRest = (tab.status === 'running' || tab.status === 'connecting') && (status === 'idle' || status === 'completed')
  next[idx] = cameToRest ? { ...tab, status, idleSince: Date.now() } : { ...tab, status }
  logTabStatusWrite(tabId, tab.status, status, source, 'applied', { came_to_rest: cameToRest })
  return next
}
