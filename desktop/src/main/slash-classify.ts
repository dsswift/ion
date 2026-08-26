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
 * The engine owns the complete command precedence chain: registered
 * extension command, built-in, markdown command or skill, then a final
 * unknown_command result. The desktop sends one request and never retries it
 * through a second prompt path.
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
import type { SendPromptArgs } from './engine-bridge-prompts'
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
 * Dispatch a parsed slash command to the engine and await the result. The
 * engine resolves the command table live at dispatch time so we never need
 * to check our snapshot cache here — we let the engine be authoritative
 * and react to the response shape.
 *
 * Returns the {@link CommandResult} so the orchestrator can decide what
 * to do next:
 *
 *   - `commandError === ""`                → engine ran the command, done
 *   - `commandError === "unknown_command"` → engine exhausted every source
 *   - any other `commandError`             → surface as a system message
 *
 * The awaiter is registered BEFORE the dispatch so we never miss the
 * event even on the local-process fast path. `awaitCommandResult`
 * attaches the global listener idempotently.
 */
export async function dispatchExtensionCommand(
  slash: ParsedSlash,
  promptArgs: SendPromptArgs,
): Promise<CommandResult> {
  log('pipeline_classify: dispatch command', { key: promptArgs.key, command: slash.command, has_args: !!slash.args })
  const waiter = awaitCommandResult(promptArgs.key, slash.command, awaitTimeoutForCommand(slash.command))
  void engineBridge.sendCommand(promptArgs, slash.command, slash.args)
  const result = await waiter
  log('pipeline_classify: command resolved', { key: promptArgs.key, command: slash.command, error: result.commandError || '(none)' })
  return result
}
