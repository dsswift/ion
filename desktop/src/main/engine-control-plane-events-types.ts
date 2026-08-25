// Shared control-plane types for the EngineEvent→NormalizedEvent translation
// layer. Extracted from engine-control-plane-events.ts so the main translation
// file and its domain-split siblings (thinking / plan / dispatch / extension)
// stay under the 600-line cap while sharing one authoritative TabEntry /
// EventEmitterContext definition. The main events file re-exports both symbols,
// so existing `import { TabEntry, EventEmitterContext } from
// './engine-control-plane-events'` sites continue to resolve unchanged.
import type { EngineBridge } from './engine-bridge'
import type { TabStatus } from '../shared/types'
import type { AutomationCausation } from '../shared/types-automation'

export interface TabEntry {
  tabId: string
  status: TabStatus
  activeRequestId: string | null
  /** Causation inherited by the active automation-started run until terminal status. */
  automationCausation?: AutomationCausation
  conversationId: string | null
  engineSessionStarted: boolean
  lastActivityAt: number
  promptCount: number
  /**
   * Number of prompts submitted since the last freshness checkpoint.
   *
   * A "checkpoint" is any event that semantically restores the tab to
   * "fresh blank session" status for the purpose of the slash-command
   * plan→auto auto-switch guard (`isFirstPromptForTab` in slash-classify.ts).
   * Two events advance this checkpoint:
   *
   *   1. `resetTabSession` — full session reset (stops the engine session,
   *      drops the conversation id). Zeros `promptCount` too.
   *   2. `notifyConversationCleared` — `/clear` succeeded. The engine
   *      session and conversation id intentionally stay alive (it's a
   *      checkpoint, not a session restart), but the LLM-visible history
   *      has been wiped, so the next slash command should be treated as
   *      the first prompt of a blank conversation. `promptCount` is
   *      preserved in that case because it remains a useful "total prompts
   *      this app boot" counter for logging.
   *
   * Why a separate field rather than reusing `promptCount`: callers of
   * `getTabStatus` may still want the total prompt count (e.g. logging),
   * so we keep both. The guard consults this checkpoint-relative counter
   * exclusively.
   */
  promptCountSinceCheckpoint: number
  /**
   * Set `true` by `notifyConversationCleared`, cleared by `submitPrompt`.
   *
   * This flag disambiguates two states that look identical to the
   * `promptCountSinceCheckpoint` counter alone:
   *
   *   A. Tab just cleared (`/clear` fired) — `promptCountSinceCheckpoint`
   *      is 0, but the renderer still sends its stale `conversationId` as
   *      `runOptions.sessionId`. The guard should treat this as fresh.
   *   B. Tab restored from disk (app restart) — `promptCountSinceCheckpoint`
   *      is 0, and the renderer sends the restored `conversationId` as
   *      `runOptions.sessionId`. The guard should treat this as resumed.
   *
   * Without this flag the guard cannot tell A from B — both have
   * `promptCountSinceCheckpoint === 0` and `runOptionsSessionId` set.
   * With the flag: A has `clearedSinceLastPrompt === true`, so the guard
   * returns "fresh" and the plan→auto switch fires. B has the flag
   * `false` (never set after a restore), so the guard returns "not fresh".
   */
  clearedSinceLastPrompt: boolean
  /**
   * Set `true` only when the tab's tracked `conversationId` came from
   * RESUMING A SAVED conversation — a caller-supplied id on restore
   * (`seedConversationId`, or `ensureSession` with `opts.conversationId`
   * provided). Left `false` when the engine MINTED a fresh id at eager
   * start for a brand-new session (the `ensureSession` capture of
   * `result.conversationId` when the tab had no prior/supplied id).
   *
   * This disambiguates a THIRD scenario that `clearedSinceLastPrompt` and
   * the bare presence of `runOptions.sessionId` cannot tell apart from a
   * restored conversation (scenario B above):
   *
   *   C. Brand-new session that eagerly started — `promptCountSinceCheckpoint`
   *      is 0, no conversation file exists on disk yet, but the engine
   *      pre-minted a `conversationId` that `ensureSession` captured onto
   *      `tab.conversationId`. The renderer then sends that minted id as
   *      `runOptions.sessionId`, so to the freshness guard it looks
   *      IDENTICAL to scenario B (count 0 + sessionId set) — yet it is
   *      genuinely fresh. The `isFirstPromptForTab` guard must treat C as
   *      fresh (so a first-prompt slash command flips plan→auto) while
   *      still treating B as resumed.
   *
   * The guard therefore keys "resumed ⇒ not fresh" off THIS flag, not off
   * the mere presence of `runOptionsSessionId` (which is set in both B and
   * C). B sets this flag `true` (caller supplied the saved id); C leaves it
   * `false` (engine minted the id).
   */
  resumedSavedConversation: boolean
  permissionMode: 'auto' | 'plan'
  approvedTools: string[]
  startedAt: number
  toolCallCount: number
  sawPermissionRequest: boolean
  /**
   * Signature of the proposal denial (ExitPlanMode / AskUserQuestion) most
   * recently surfaced to the renderer via a synthesized task_complete.
   *
   * The engine RE-PUBLISHES its retained `lastPermissionDenials` on every
   * heartbeat idle (engine `manager_heartbeat.go`) so a reattaching consumer
   * sees the pending proposal. A settled ('completed' / 'idle') tab therefore
   * receives the SAME ExitPlanMode denial on every cost-only heartbeat tick.
   *
   * Without dedup, exempting proposal-bearing idles from the duplicate-skip
   * guard (so the first proposal is never dropped — Bug #2) would re-synthesize
   * a task_complete on every heartbeat and could resurrect a card the user
   * already dismissed. This signature records what was last surfaced so the
   * proposal pass-through fires ONCE per distinct proposal: the first delivery
   * surfaces it; identical heartbeat echoes are skipped; a genuinely new
   * proposal (different tool / plan path / run) re-fires.
   *
   * Reset to null on a real run start (state='running') and on session
   * reset/clear, so the next proposal after new work always re-surfaces.
   */
  lastSurfacedProposalSig: string | null
  /**
   * The engine's run epoch as of this tab's most recent dispatch, or null when
   * the tab has never dispatched (or the engine does not send the field).
   *
   * Recorded from the last `engine_status` seen before submitPrompt asks for a
   * session, and compared against every later idle snapshot to tell one built
   * BEFORE the prompt from the one that ends the resulting run. See
   * engine-control-plane-idle-ordering.ts for the full framing.
   */
  dispatchRunEpoch: number | null
  /**
   * The run epoch carried by the most recent `engine_status` for this tab, or
   * null when no snapshot has carried one. Updated on EVERY status event
   * regardless of state, so the value submitPrompt records is the freshest
   * reading available at dispatch time.
   */
  lastObservedRunEpoch: number | null
  /**
   * True once the engine has acknowledged the prompt now in flight — the
   * `send_prompt` RPC returned. Cleared at dispatch, set when the send
   * resolves.
   *
   * The fallback ordering signal for an engine binary that predates
   * `runEpoch`. The engine assigns run identity inside SendPrompt before it
   * replies, so the acknowledgement is the exact boundary between "no run yet"
   * and "run exists". See engine-control-plane-idle-ordering.ts.
   */
  dispatchAcknowledged: boolean
}

export interface EventEmitterContext {
  bridge: EngineBridge
  emit: (eventName: string, ...args: unknown[]) => void
  setStatus: (tabId: string, newStatus: TabStatus) => void
  checkDrain: () => void
}
