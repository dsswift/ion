/**
 * prompt-pipeline-slash.ts — the slash branch of the unified prompt pipeline.
 *
 * Extracted from prompt-pipeline.ts to keep that orchestrator under the 600-line
 * cap, following the same one-way-seam pattern already used for
 * prompt-pipeline-renderer.ts and prompt-pipeline-prose.ts. This file owns:
 *
 *   - handleSlash — the slash-command decision: dispatch to the engine command
 *     registry, and on `unknown_command` re-submit the RAW invocation with
 *     resolveSlash=true so the engine resolves + expands the template (the
 *     engine OWNS slash resolution; the desktop is a courier). Also performs the
 *     desktop-owned plan→auto flip on the first slash command of a checkpoint.
 *   - surfaceEngineUnknownCommand — out-of-band "Unknown command" system message
 *     when the engine ALSO cannot resolve the resolveSlash re-submit.
 *
 * The two module-local functions handleSlash needs from the orchestrator
 * (engineKey, submitAsPrompt) are injected via SlashDeps so the seam stays
 * one-way (orchestrator → this file → engine bridge / renderer helpers) and this
 * file does not import back into prompt-pipeline.ts.
 */

import { IPC } from '../shared/types'
import { log as _log } from './logger'
import { sessionPlane } from './state'
import { broadcast } from './broadcast'
import { type ParsedSlash } from './slash-parse'
import { dispatchExtensionCommand, isFirstPromptForTab } from './slash-classify'
import { awaitCommandResult } from './command-await'
import { handleLocalClearShortCircuit } from './slash-clear'
import { emitRemoteMessageAdded, insertRendererSystemMessage, clearConnectingStatus } from './prompt-pipeline-renderer'
// Type-only import: the IncomingPrompt shape lives with the orchestrator. A
// type import creates no runtime dependency, so the runtime seam stays one-way
// (orchestrator → this file → engine bridge / renderer helpers).
import type { IncomingPrompt } from './prompt-pipeline'

function log(msg: string): void {
  _log('main', msg)
}

/** Orchestrator-supplied helpers the slash branch needs. Injected to keep the
 *  seam one-way (this file never imports prompt-pipeline.ts). */
export interface SlashDeps {
  engineKey: (p: IncomingPrompt) => string
  submitAsPrompt: (p: IncomingPrompt) => Promise<void>
}

/**
 * Out-of-band: surface a system message when the ENGINE also fails to resolve
 * the slash on the resolveSlash re-submit. The engine emits
 * engine_command_result{unknown_command} only on a resolve FAILURE (success
 * starts a run → no command result), so we act only on unknown_command;
 * timeout (the success outcome) and any other shape are ignored. The re-submit
 * does not block on this. Errors are logged, never thrown.
 */
async function surfaceEngineUnknownCommand(p: IncomingPrompt, slash: ParsedSlash, deps: SlashDeps): Promise<void> {
  try {
    const result = await awaitCommandResult(deps.engineKey(p), slash.command)
    if (result.commandError === 'unknown_command') {
      log(`pipeline: engine resolveSlash disclaimed /${slash.command} → emitting unknown-command system message`)
      const msg = `Unknown command: /${slash.command}`
      await insertRendererSystemMessage(p, msg)
      if (p.source === 'remote') emitRemoteMessageAdded(p, msg, 'system')
      await clearConnectingStatus(p)
    } else {
      log(`pipeline: engine resolveSlash result /${slash.command} err=${result.commandError || '(none/timeout-or-success)'} → no system message`)
    }
  } catch (err) {
    log(`pipeline: surfaceEngineUnknownCommand error /${slash.command}: ${(err as Error).message}`)
  }
}

export async function handleSlash(p: IncomingPrompt, slash: ParsedSlash, deps: SlashDeps): Promise<void> {
  // Echo the raw slash text to iOS so the optimistic timestamp is corrected.
  if (p.source === 'remote') {
    emitRemoteMessageAdded(p, p.text, 'user')
  }

  const result = await dispatchExtensionCommand(deps.engineKey(p), slash)

  if (result.commandError === '') {
    // Success. Clear the optimistic 'connecting' state because no run will
    // follow for a pure command. (Extensions that DO start a run will set
    // status='running' via run_start before this clear executes, and the
    // clear is a no-op when status isn't 'connecting'.)
    log(`pipeline: ext cmd success key=${deps.engineKey(p)} cmd=/${slash.command}`)
    await clearConnectingStatus(p)
    return
  }

  if (result.commandError === 'unknown_command') {
    // Special case: `/clear` when the engine has no session yet (e.g. a fresh
    // tab where no prompt has been submitted). The engine cannot run
    // dispatchClear because the session doesn't exist, so it returns
    // unknown_command. From the user's perspective the conversation IS already
    // empty — the correct behaviour is a divider, not an "Unknown command"
    // error. We short-circuit here and render the divider locally, matching
    // the semantics dispatchClear documents for the "never-talked-to" case.
    // All other unknown commands re-submit to the engine with resolveSlash.
    if (slash.command === 'clear') {
      await handleLocalClearShortCircuit(p, deps.engineKey(p))
      return
    }

    // The engine has no extension/built-in named /<command>. Rather than
    // expanding `.md` templates locally (retired — the engine now OWNS slash
    // resolution + expansion), re-submit the RAW invocation back to the engine
    // with resolveSlash=true so it resolves + expands the template itself and
    // persists the raw invocation as the displayed turn. If the engine also
    // can't resolve it, it emits engine_command_result{unknown_command}, which
    // surfaceEngineUnknownCommand turns into a system message below.
    //
    // Rebuild the raw `/command args` from the parse (p.text already holds it,
    // but rebuilding makes the contract explicit and normalisation-robust).
    const rawInvocation = '/' + slash.command + (slash.args ? ' ' + slash.args : '')
    log(`pipeline: engine disclaimed /${slash.command} → re-submitting raw invocation to engine with resolveSlash=true (text="${rawInvocation.substring(0, 60)}")`)
    p.text = rawInvocation
    if (p.runOptions) {
      p.runOptions.prompt = rawInvocation
    }
    p.resolveSlash = true

    // Plan→auto auto-switch (DESKTOP policy, not an engine concern). A slash
    // command represents "run this task", which is incompatible with plan
    // mode — so when the slash command is the FIRST prompt of the current
    // checkpoint window (fresh tab, or freshly `/clear`ed), the desktop tells
    // the engine to exit plan mode before forwarding the command. The engine
    // does not own this behavior: it never decides to leave plan mode on its
    // own for a command; the client that toggles plan mode on the session is
    // responsible. setPermissionMode(tabId, 'auto') flips local tab state AND
    // calls sendSetPlanMode(false) on the engine; the broadcast mirrors the
    // change to remote (iOS) consumers.
    //
    // Guard: only on the first prompt of the checkpoint window. A
    // mid-conversation slash command (promptCountSinceCheckpoint > 0) or a
    // resumed session preserves the current permission mode, so a plan-mode
    // conversation stays in plan mode when the user invokes a command midway.
    // This restores the behavior the retired local-expansion path performed in
    // tryExpandMarkdownSlash before slash resolution moved to the engine.
    if (!p.isEngineTab && isFirstPromptForTab(p.tabId, p.runOptions?.sessionId)) {
      log(`pipeline: first-prompt slash command on tab=${p.tabId} → flipping plan→auto before submit`)
      sessionPlane.setPermissionMode(p.tabId, 'auto', 'slash_command')
      broadcast(IPC.REMOTE_SET_PERMISSION_MODE, { tabId: p.tabId, mode: 'auto' })
    } else {
      log(`pipeline: slash command not first-of-checkpoint on tab=${p.tabId} (promptCount=${sessionPlane.getTabStatus(p.tabId)?.promptCountSinceCheckpoint ?? '?'}, sessionId=${p.runOptions?.sessionId ?? 'none'}, engineTab=${p.isEngineTab}) → preserving permission mode`)
    }

    // Surface a system message if the ENGINE also fails to resolve the slash.
    // The engine emits engine_command_result{commandError:'unknown_command'}
    // when a resolveSlash send cannot be resolved across any of its command
    // roots; on success it starts a run (no command_result), so this awaiter
    // simply times out and we ignore the timeout. We only act on a genuine
    // unknown_command, which preserves the legacy "Unknown command" UX
    // without risking a spurious error on the success path. Fire-and-forget:
    // the re-submit itself does not block on this.
    void surfaceEngineUnknownCommand(p, slash, deps)
    await deps.submitAsPrompt(p)
    return
  }

  // Extension error, timeout, or other failure shape.
  log(`pipeline: ext cmd failed key=${deps.engineKey(p)} cmd=/${slash.command} err=${result.commandError}`)
  const errMsg = result.message || `Command failed: /${slash.command}: ${result.commandError}`
  await insertRendererSystemMessage(p, errMsg)
  if (p.source === 'remote') emitRemoteMessageAdded(p, errMsg, 'system')
  await clearConnectingStatus(p)
}
