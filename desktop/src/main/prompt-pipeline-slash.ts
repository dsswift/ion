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
import { sessionPlane, engineBridge } from './state'
import { broadcast } from './broadcast'
import { type ParsedSlash } from './slash-parse'
import { dispatchExtensionCommand, isFirstPromptForTab } from './slash-classify'
import { awaitCommandResult } from './command-await'
import { handleLocalClearShortCircuit } from './slash-clear'
import { emitRemoteMessageAdded, insertRendererSystemMessage, clearConnectingStatus, insertRendererRemoteUserMessage } from './prompt-pipeline-renderer'
// Type-only import: the IncomingPrompt shape lives with the orchestrator. A
// type import creates no runtime dependency, so the runtime seam stays one-way
// (orchestrator → this file → engine bridge / renderer helpers).
import type { IncomingPrompt } from './prompt-pipeline'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
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
      log('pipeline_slash: disclaimed, emitting unknown-command', { command: slash.command })
      const msg = `Unknown command: /${slash.command}`
      await insertRendererSystemMessage(p, msg)
      if (p.source === 'remote') emitRemoteMessageAdded(p, msg, 'system')
      await clearConnectingStatus(p)
    } else {
      log('pipeline_slash: resolveSlash result', { command: slash.command, error: result.commandError || '(none/timeout-or-success)' })
    }
  } catch (err) {
    log('pipeline_slash: surfaceEngineUnknownCommand error', { command: slash.command, error: (err as Error).message })
  }
}

/**
 * Plan→auto auto-switch (DESKTOP policy, not an engine concern). A slash
 * command represents "run this task", which is incompatible with plan mode — so
 * when the slash command is the FIRST prompt of the current checkpoint window
 * (fresh tab, or freshly `/clear`ed), the desktop tells the engine to exit plan
 * mode before the command executes. The engine never decides to leave plan mode
 * on its own for a command; the client that toggles plan mode on the session is
 * responsible. `setPermissionMode(tabId, 'auto')` flips local tab state AND calls
 * `sendSetPlanMode(false)` on the engine; the broadcast mirrors the change to
 * remote (iOS) consumers.
 *
 * This policy is TAB-TYPE-AGNOSTIC (plain and extension-hosted alike: both
 * `isFirstPromptForTab` and `setPermissionMode` are tab-type-agnostic, the latter
 * bare-tabId keyed) and BRANCH-AGNOSTIC: it must fire whether the engine resolves
 * the slash directly (`commandError === ''`, which can start a run —
 * see clearConnectingStatus note below) or disclaims it (`unknown_command`, which
 * re-submits with resolveSlash and starts a run). A prior version only flipped on
 * the unknown_command re-submit branch, so a first-prompt slash that the engine's
 * command registry resolved directly executed under the still-active plan mode.
 *
 * Exclusions:
 *   - `/clear` is a checkpoint, not a task. It must never change permission mode,
 *     so the caller excludes it (it can arrive on either branch).
 *
 * Guard: only on the first prompt of the checkpoint window. A mid-conversation
 * slash command (`promptCountSinceCheckpoint > 0`) or a resumed session preserves
 * the current permission mode, so a plan-mode conversation stays in plan mode when
 * the user invokes a command midway. This restores the behavior the retired
 * local-expansion path performed in `tryExpandMarkdownSlash` before slash
 * resolution moved to the engine.
 */
function maybeFlipPlanToAutoForSlash(p: IncomingPrompt): void {
  if (isFirstPromptForTab(p.tabId)) {
    log('pipeline_slash: first-prompt slash, flipping plan to auto', { tab_id: p.tabId })
    sessionPlane.setPermissionMode(p.tabId, 'auto', 'slash_command')
    broadcast(IPC.REMOTE_SET_PERMISSION_MODE, { tabId: p.tabId, mode: 'auto' })
  } else {
    const _tab = sessionPlane.getTabStatus(p.tabId)
    log('pipeline_slash: not first-of-checkpoint, preserving permission mode', { tab_id: p.tabId })
  }
}

/**
 * Handle `/plugin install <source>`, `/plugin list`, `/plugin remove <name>`.
 * These are engine wire commands dispatched directly — not extension slash commands.
 * Results are surfaced as system messages in the renderer.
 */
async function handlePluginSlash(p: IncomingPrompt, args: string): Promise<void> {
  const parts = args.trim().split(/\s+/)
  const sub = parts[0] || ''
  log('pipeline_slash: plugin command', { sub, args })

  if (sub === 'install') {
    const source = parts[1] || ''
    if (!source) {
      await insertRendererSystemMessage(p, 'Usage: /plugin install <owner/repo>')
      return
    }
    await insertRendererSystemMessage(p, `Installing plugin ${source}...`)
    try {
      const result = await engineBridge.request('plugin_install', { source })
      if (result?.ok) {
        const d = result.data as { name?: string; version?: string } | undefined
        await insertRendererSystemMessage(p, `Installed plugin: ${d?.name ?? source} (${d?.version ?? ''})`)
      } else {
        await insertRendererSystemMessage(p, `Plugin install failed: ${result?.error ?? 'unknown error'}`)
      }
    } catch (err) {
      await insertRendererSystemMessage(p, `Plugin install error: ${(err as Error).message}`)
    }
    return
  }

  if (sub === 'list') {
    try {
      const result = await engineBridge.request('plugin_list', {})
      if (result?.ok) {
        const plugins = (result.data ?? []) as Array<{ name: string; source: string; version: string }>
        if (plugins.length === 0) {
          await insertRendererSystemMessage(p, 'No plugins installed.')
        } else {
          const lines = plugins.map((pl) => `  ${pl.name}  (${pl.source}@${pl.version})`).join('\n')
          await insertRendererSystemMessage(p, `Installed plugins:\n${lines}`)
        }
      } else {
        await insertRendererSystemMessage(p, `Plugin list failed: ${result?.error ?? 'unknown error'}`)
      }
    } catch (err) {
      await insertRendererSystemMessage(p, `Plugin list error: ${(err as Error).message}`)
    }
    return
  }

  if (sub === 'remove') {
    const name = parts[1] || ''
    if (!name) {
      await insertRendererSystemMessage(p, 'Usage: /plugin remove <name>')
      return
    }
    try {
      const result = await engineBridge.request('plugin_remove', { label: name })
      if (result?.ok) {
        await insertRendererSystemMessage(p, `Removed plugin: ${name}`)
      } else {
        await insertRendererSystemMessage(p, `Plugin remove failed: ${result?.error ?? 'unknown error'}`)
      }
    } catch (err) {
      await insertRendererSystemMessage(p, `Plugin remove error: ${(err as Error).message}`)
    }
    return
  }

  await insertRendererSystemMessage(p, 'Usage: /plugin install <owner/repo> | /plugin list | /plugin remove <name>')
}

export async function handleSlash(p: IncomingPrompt, slash: ParsedSlash, deps: SlashDeps): Promise<void> {
  // Echo the raw slash text to iOS so the optimistic timestamp is corrected.
  if (p.source === 'remote') {
    emitRemoteMessageAdded(p, p.text, 'user')
  }

  // ── Plugin management short-circuit ─────────────────────────────────────
  // `/plugin install <owner/repo>`, `/plugin list`, `/plugin remove <name>`
  // are engine wire commands, not extension slash commands. Intercept them
  // here and dispatch through the plugin IPC handlers directly so they work
  // without a session and return results as system messages.
  if (slash.command === 'plugin') {
    await handlePluginSlash(p, slash.args ?? '')
    await clearConnectingStatus(p)
    return
  }

  const result = await dispatchExtensionCommand(deps.engineKey(p), slash)
  if (result.commandError === '') {
    // The engine resolved the command directly. It MAY start a run (the comment
    // on clearConnectingStatus below) — so a first-prompt slash command must
    // exit plan mode before it executes, exactly as the unknown_command branch
    // does. `/clear` is excluded: it is a checkpoint, not a task, and must not
    // change permission mode.
    if (slash.command !== 'clear') {
      maybeFlipPlanToAutoForSlash(p)

      // For remote-originated prompts, insert the user message into the desktop
      // renderer store. The renderer's submit() was never called for this prompt
      // (the pipeline handled it directly), so the store has no user bubble.
      // Without this, the desktop shows assistant text with no preceding user
      // turn, and iOS history reads (which pull from the renderer store) also
      // miss it. The iOS device already has the message from the
      // desktop_message_added echo in tabs-prompt.ts; this insert is for the
      // desktop renderer only. /clear is excluded: it is a checkpoint that
      // renders as a divider, not a user turn.
      if (p.source === 'remote') {
        const rawInvocation = '/' + slash.command + (slash.args ? ' ' + slash.args : '')
        void insertRendererRemoteUserMessage(p, rawInvocation, '/' + slash.command, slash.args)
      }
    }

    // Clear the optimistic 'connecting' state because no run will follow for a
    // pure command. (Extensions that DO start a run will set status='running'
    // via run_start before this clear executes, and the clear is a no-op when
    // status isn't 'connecting'.)
    log('pipeline_slash: ext cmd success', { key: deps.engineKey(p), command: slash.command })
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
    log('pipeline_slash: disclaimed, re-submitting with resolveSlash', { command: slash.command, preview: rawInvocation.substring(0, 60) })
    p.text = rawInvocation
    if (p.runOptions) {
      p.runOptions.prompt = rawInvocation
    }
    p.resolveSlash = true

    // Exit plan mode on the first prompt of the checkpoint window before the
    // resolveSlash re-submit starts its run. `/clear` already short-circuited
    // above, so this branch never flips for it. See maybeFlipPlanToAutoForSlash.
    maybeFlipPlanToAutoForSlash(p)

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
  log('pipeline_slash: ext cmd failed', { key: deps.engineKey(p), command: slash.command, error: result.commandError })
  const errMsg = result.message || `Command failed: /${slash.command}: ${result.commandError}`
  await insertRendererSystemMessage(p, errMsg)
  if (p.source === 'remote') emitRemoteMessageAdded(p, errMsg, 'system')
  await clearConnectingStatus(p)
}
