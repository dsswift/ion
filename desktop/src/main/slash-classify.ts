/**
 * Slash-command classification helper.
 *
 * Extracted from prompt-pipeline.ts to keep that orchestrator file under
 * the 600-line cap. This module owns the one non-orchestration helper the
 * slash branch of the pipeline calls:
 *
 *   `dispatchExtensionCommand` — sends the slash to the engine's command
 *   registry and awaits the result event. The engine resolves its own
 *   extension-command table; the desktop is purely a courier here.
 *
 * Local `.md` template expansion has been RETIRED: the engine now OWNS
 * slash resolution + expansion (template lookup across `.ion/commands`,
 * `.claude/commands`, skills, and project roots, plus $ARGUMENTS
 * substitution and frontmatter handling). On `unknown_command`, the
 * pipeline re-submits the raw invocation to the engine with
 * resolveSlash=true rather than expanding locally — see
 * `prompt-pipeline.ts:handleSlash`.
 *
 * `dispatchExtensionCommand` does not call back into the orchestrator: the
 * seam between this file and prompt-pipeline.ts is one-way (orchestrator →
 * helper → engine bridge), matching the rest of the helper layer.
 *
 * Companion file: `slash-parse.ts` owns the canonical slash regex and the
 * `ParsedSlash` type. This file imports the parsed result; it does NOT
 * re-parse.
 */

import { log as _log } from './logger'
import { sessionPlane, engineBridge } from './state'
import { type ParsedSlash } from './slash-parse'
import { awaitCommandResult, type CommandResult } from './command-await'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

/**
 * Per-command awaiter timeout override (ms).
 *
 * `awaitCommandResult` is a crash-safety net: it resolves with a synthetic
 * `commandError: 'timeout'` if the engine never emits an
 * `engine_command_result`, so the pipeline can't hang on an engine crash. The
 * 5s default (command-await.ts) suits built-ins that resolve near-instantly.
 *
 * `/compact` is different: the engine now runs it asynchronously and emits the
 * result only when the compaction COMPLETES, which includes a blocking LLM
 * summarization that routinely takes tens of seconds on a large conversation.
 * With the 5s default the awaiter fired its synthetic timeout while the engine
 * was still legitimately working — surfacing "timeout waiting for
 * engine_command_result" to the user for a compaction that in fact succeeded.
 * Because the engine dispatches compaction off the read loop, a long awaiter
 * costs nothing (it holds only a per-promise timer, blocks nothing), so we give
 * compact a generous 180s ceiling that outlasts any realistic summarization
 * while still bounding a genuine engine crash.
 */
const COMPACT_TIMEOUT_MS = 180_000

/** Resolve the awaiter timeout for a command. Returns undefined to use the
 *  awaitCommandResult default (5s). Only slow, engine-async built-ins override.
 *  Exported for direct unit testing of the selection policy. */
export function awaitTimeoutForCommand(command: string): number | undefined {
  if (command === 'compact') return COMPACT_TIMEOUT_MS
  return undefined
}

/**
 * Returns true when a slash command is the **first** prompt on a fresh tab —
 * where "fresh" means "since the last freshness checkpoint".
 *
 * Used by the slash branch of prompt-pipeline.ts to decide whether to flip the
 * tab from plan→auto before forwarding a slash command. The plan→auto switch is
 * a DESKTOP policy (a slash command means "run this task", incompatible with
 * plan mode) — the engine does not own it; the client that toggles plan mode on
 * the session is responsible. The flip itself lives in `handleSlash`
 * (prompt-pipeline.ts); this predicate is the pure first-prompt test it consults.
 * What counts as a checkpoint (i.e. what resets `promptCountSinceCheckpoint`
 * back to 0, restoring "fresh" status):
 *
 *   - `EngineControlPlane.resetTabSession` — full session reset.
 *   - `EngineControlPlane.notifyConversationCleared` — fired when `/clear`
 *     succeeds. The engine keeps the same `conversationId` after `/clear`
 *     (it's a checkpoint, not a session restart), so this guard CANNOT rely
 *     on `conversationId` being null to recognize a freshly-cleared tab.
 *
 * "Not fresh" is driven by two signals on the tab entry:
 *   1. `resumedSavedConversation === true` — the tab's tracked conversationId
 *      came from RESUMING A SAVED conversation (caller-supplied id on restore),
 *      not from a fresh engine mint. This replaces the old "any non-null
 *      runOptions.sessionId ⇒ resumed" heuristic, which mis-classified a
 *      brand-new eagerly-started session (whose engine-minted id the renderer
 *      also sends as runOptions.sessionId) as resumed — the bug that ran a
 *      first-prompt `/align` in plan mode. See resumedSavedConversation in
 *      engine-control-plane-events.ts for scenarios B (resume) vs C (mint).
 *   2. `promptCountSinceCheckpoint > 0` — at least one prompt has been
 *      submitted in the current checkpoint window.
 *
 * Edge-cases:
 *   - `getTabStatus(tabId)` returns `undefined` → tab not yet registered,
 *     i.e. genuinely fresh. Returns true.
 *   - `clearedSinceLastPrompt` → `/clear` just fired; treat as fresh.
 *
 * @param tabId The active tab id.
 */
export function isFirstPromptForTab(tabId: string): boolean {
  const tab = sessionPlane.getTabStatus(tabId)
  // Tab not registered yet — genuinely fresh.
  if (!tab) return true
  // /clear just fired — treat as fresh even though the renderer still sends
  // the stale conversationId. The flag is cleared by submitPrompt.
  if (tab.clearedSinceLastPrompt) return true
  // Resuming a SAVED conversation (scenario B) — not fresh. We key off the
  // explicit resumedSavedConversation flag, NOT the bare presence of a
  // runOptions.sessionId: the engine pre-mints a conversationId for a brand-new
  // eagerly-started session (scenario C), which the renderer then sends as
  // runOptions.sessionId — so a non-null sessionId alone cannot distinguish a
  // real resume (B) from a fresh mint (C). Only B sets the flag. See the
  // resumedSavedConversation doc in engine-control-plane-events.ts.
  if (tab.resumedSavedConversation) return false
  return tab.promptCountSinceCheckpoint === 0
}

/**
 * Dispatch a parsed slash command to the engine and await the result. The
 * engine resolves the command table live at dispatch time so we never need
 * to check our snapshot cache here — we let the engine be authoritative
 * and react to the response shape.
 *
 * Returns the {@link CommandResult} so the orchestrator can decide what
 * to do next:
 *
 *   - `commandError === ""`                → engine ran the command, done
 *   - `commandError === "unknown_command"` → re-submit with resolveSlash=true
 *   - any other `commandError`             → surface as a system message
 *
 * The awaiter is registered BEFORE the dispatch so we never miss the
 * event even on the local-process fast path. `awaitCommandResult`
 * attaches the global listener idempotently.
 */
export async function dispatchExtensionCommand(
  key: string,
  slash: ParsedSlash,
): Promise<CommandResult> {
  log('pipeline_classify: dispatch ext cmd', { key, command: slash.command, has_args: !!slash.args })
  const waiter = awaitCommandResult(key, slash.command, awaitTimeoutForCommand(slash.command))
  void engineBridge.sendCommand(key, slash.command, slash.args)
  const result = await waiter
  log('pipeline_classify: ext cmd resolved', { key, command: slash.command, error: result.commandError || '(none)' })
  return result
}
