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

function log(msg: string): void {
  _log('main', msg)
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
 * Two sources of "this is a resumed session" — both still count as NOT-fresh:
 *   1. `runOptionsSessionId` — the renderer passes `runOptions.sessionId`
 *      when submitting a prompt against a previously-saved conversation.
 *   2. `promptCountSinceCheckpoint > 0` — at least one prompt has been
 *      submitted in the current checkpoint window.
 *
 * Edge-cases:
 *   - `getTabStatus(tabId)` returns `undefined` → tab not yet registered,
 *     i.e. genuinely fresh. Returns true.
 *   - `clearedSinceLastPrompt` → `/clear` just fired; treat as fresh.
 *
 * @param tabId               The active tab id.
 * @param runOptionsSessionId The `sessionId` from `RunOptions` sent by the
 *                            renderer — non-null when resuming a saved
 *                            conversation.
 */
export function isFirstPromptForTab(tabId: string, runOptionsSessionId?: string | null): boolean {
  const tab = sessionPlane.getTabStatus(tabId)
  // Tab not registered yet — genuinely fresh.
  if (!tab) return true
  // /clear just fired — treat as fresh even though the renderer still sends
  // the stale conversationId. The flag is cleared by submitPrompt.
  if (tab.clearedSinceLastPrompt) return true
  // Renderer is resuming a saved conversation — not fresh.
  if (runOptionsSessionId) return false
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
  log(`pipeline: dispatch ext cmd key=${key} cmd=/${slash.command} hasArgs=${!!slash.args}`)
  const waiter = awaitCommandResult(key, slash.command)
  void engineBridge.sendCommand(key, slash.command, slash.args)
  const result = await waiter
  log(`pipeline: ext cmd resolved key=${key} cmd=/${slash.command} err=${result.commandError || '(none)'}`)
  return result
}
