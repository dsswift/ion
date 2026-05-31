/**
 * Slash-command classification + `.md` template expansion helpers.
 *
 * Extracted from prompt-pipeline.ts to keep that orchestrator file under
 * the 600-line cap. This module owns the two non-orchestration helpers
 * the slash branch of the pipeline calls:
 *
 *   1. `dispatchExtensionCommand` — sends the slash to the engine's
 *      command registry and awaits the result event. The engine resolves
 *      its own extension-command table; the desktop is purely a courier
 *      here.
 *
 *   2. `tryExpandMarkdownSlash` — expands a `.md` template into a
 *      user/system prompt pair. Ion-native paths (`.ion/commands/`) are
 *      always probed; Claude-compat paths (`.claude/commands/`,
 *      `.claude/skills/`) are only probed when `enableClaudeCompat` is
 *      enabled in settings.
 *
 * Neither helper calls back into the orchestrator. `tryExpandMarkdownSlash`
 * used to mutate the in-flight `IncomingPrompt` and recurse into
 * `submitAsPrompt`; that recursion has been moved up to the orchestrator,
 * which now reads the returned `ExpansionResult` and decides what to do.
 * Result: the seam between this file and prompt-pipeline.ts is one-way
 * (orchestrator → helpers → engine bridge), which matches the rest of
 * the helper layer.
 *
 * Companion file: `slash-parse.ts` owns the canonical slash regex and
 * the `ParsedSlash` type. This file imports the parsed result; it does
 * NOT re-parse.
 */

import { log as _log } from './logger'
import { sessionPlane, engineBridge } from './state'
import { broadcast } from './broadcast'
import { type ParsedSlash } from './slash-parse'
import { awaitCommandResult, type CommandResult } from './command-await'
import { expandSlashCommand } from './cli-compat/slash-expand'
import { readSettings, SETTINGS_DEFAULTS } from './settings-store'
import { IPC } from '../shared/types'

function log(msg: string): void {
  _log('main', msg)
}

/**
 * Result of a successful `.md` template expansion. The orchestrator uses
 * this to rewrite the in-flight prompt and re-enter the submission path.
 *
 * When expansion did not occur (claudeCompat disabled, or no matching
 * template), `tryExpandMarkdownSlash` returns `null` and the orchestrator
 * falls through to its "unknown command" branch.
 */
export interface ExpansionResult {
  /** Expanded user-facing prompt text (replaces the original slash). */
  userPrompt: string
  /**
   * Expanded system-prompt addition (frontmatter-derived). May be empty
   * when the template carries no frontmatter. The orchestrator appends
   * this to any existing `appendSystemPrompt` rather than replacing it.
   */
  systemPrompt: string
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
 *   - `commandError === "unknown_command"` → fall through to `.md` expansion
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

/**
 * Try to expand a parsed slash as a `.md` template. Ion-native paths
 * (`.ion/commands/`) are always probed first. Claude-compat paths
 * (`.claude/commands/`, `.claude/skills/`) are probed only when the
 * `enableClaudeCompat` setting is enabled. Returns the expanded
 * user/system prompt pair on success, or `null` when no expansion
 * occurred (no matching template in any searched path).
 *
 * Side effects: on a successful expansion this function flips the tab's
 * permission mode to `'auto'` and broadcasts the change to remote
 * consumers, matching the legacy `applySlashExpansion` semantics. The
 * mode flip happens here (not in the orchestrator) because it is part of
 * the expansion contract: a `.md` template is conceptually "run this
 * task", which is incompatible with plan mode.
 *
 * The orchestrator is responsible for actually re-entering the
 * submission path with the returned values — this helper does NOT
 * recurse into prompt-pipeline.ts. Keeping the call graph one-way makes
 * the test surface smaller and the dependency direction clearer.
 *
 * @param tabId   the active tab; used for the permission-mode flip
 * @param slash   the parsed slash command (name + args)
 * @param projectPath  working directory for the `.md` template lookup
 */
export async function tryExpandMarkdownSlash(
  tabId: string,
  slash: ParsedSlash,
  projectPath: string | undefined,
): Promise<ExpansionResult | null> {
  const rebuilt = '/' + slash.command + (slash.args ? ' ' + slash.args : '')

  // 1. Always try Ion-native paths (.ion/commands/) — not gated
  const ionExpansion = await expandSlashCommand(rebuilt, projectPath, 'ion')
  if (ionExpansion.expanded) {
    log(`pipeline: .ion/ expanded /${slash.command} → userLen=${ionExpansion.userPrompt.length} sysLen=${ionExpansion.systemPrompt.length}`)
    sessionPlane.setPermissionMode(tabId, 'auto', 'slash_command')
    broadcast(IPC.REMOTE_SET_PERMISSION_MODE, { tabId, mode: 'auto' })
    return {
      userPrompt: ionExpansion.userPrompt,
      systemPrompt: ionExpansion.systemPrompt,
    }
  }

  // 2. Try Claude-compat paths (.claude/commands/, .claude/skills/) — gated
  let claudeCompat = SETTINGS_DEFAULTS.enableClaudeCompat
  try {
    const s = readSettings()
    claudeCompat = s.enableClaudeCompat ?? claudeCompat
  } catch { /* default */ }
  if (!claudeCompat) {
    log(`pipeline: .md expansion skipped (.claude/ gated off), name=${slash.command}`)
    return null
  }

  const claudeExpansion = await expandSlashCommand(rebuilt, projectPath, 'claude')
  if (!claudeExpansion.expanded) {
    log(`pipeline: no .md expansion for /${slash.command}`)
    return null
  }
  log(`pipeline: .claude/ expanded /${slash.command} → userLen=${claudeExpansion.userPrompt.length} sysLen=${claudeExpansion.systemPrompt.length}`)

  // Auto-switch permission mode to 'auto' (matches legacy
  // applySlashExpansion semantics). The flip lives here rather than in
  // the orchestrator because it is part of the expansion contract — a
  // `.md` template represents "run this task", which is incompatible
  // with plan mode. Putting the side effect at the source of the
  // expansion keeps the orchestrator's expansion-handling code branch
  // a pure data flow.
  sessionPlane.setPermissionMode(tabId, 'auto', 'slash_command')
  broadcast(IPC.REMOTE_SET_PERMISSION_MODE, { tabId, mode: 'auto' })

  return {
    userPrompt: claudeExpansion.userPrompt,
    systemPrompt: claudeExpansion.systemPrompt,
  }
}
