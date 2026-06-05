/**
 * Unified prompt pipeline — the single decision tree for what to do with a
 * user-typed string, regardless of which client (desktop renderer, iOS remote)
 * sent it.
 *
 * Why this exists
 * ───────────────
 * Before this module, four independent call sites made slash-command
 * decisions with subtly different regexes and precedence rules:
 *
 *   1. `desktop/src/renderer/components/InputBar.tsx` parsed `^\/(\S+)...`
 *      and dispatched to `window.ion.engineCommand` for ANY name shape.
 *   2. `desktop/src/main/ipc/session.ts:applySlashExpansion` knew only
 *      about `.md` template expansion; it never dispatched extension
 *      commands.
 *   3. `desktop/src/main/remote/handlers/slash-intercept.ts:interceptCliSlash`
 *      knew only about extension-command dispatch; it never expanded `.md`
 *      templates.
 *   4. `slash-intercept.ts:interceptEngineSlash` mirrored #3 for engine tabs.
 *
 * The investigation that produced this module showed that iOS sending
 * `/ion--review-changes 138, 139` silently stalled the conversation because
 * the remote handler routed it as an extension-command (the engine had no
 * such extension command registered) and the `.md` template at
 * `.claude/commands/ion--review-changes.md` was never tried.
 *
 * The structural fix: clients become dumb pipes carrying raw text. All
 * slash-routing policy lives here and is invoked from every entry point
 * (IPC PROMPT, IPC ENGINE_PROMPT, remote handlePrompt, remote
 * handleEnginePrompt).
 *
 * Decision tree
 * ─────────────
 *   raw text
 *     │
 *     ├─ starts with "!" (and length > 1) → bash shortcut (CLI only)
 *     │
 *     ├─ parses as /<name>[ args]
 *     │     │
 *     │     ├─ dispatch to engine as extension command, await result
 *     │     │     │
 *     │     │     ├─ commandError = "" (success)  → DONE
 *     │     │     │
 *     │     │     ├─ commandError = "unknown_command"
 *     │     │     │   │   (engine has no such extension or built-in)
 *     │     │     │   ├─ try `.md` expansion via expandSlashCommand
 *     │     │     │   │   │
 *     │     │     │   │   ├─ expanded → re-enter pipeline as normal prompt
 *     │     │     │   │   │             (auto-switch permission mode)
 *     │     │     │   │   │
 *     │     │     │   │   └─ not expanded → emit "unknown command" system
 *     │     │     │   │                       message and stop
 *     │     │     │   │
 *     │     │     │   └─ ── (no other branch — the result is fully classified)
 *     │     │     │
 *     │     │     └─ commandError = "timeout" or extension error
 *     │     │           → emit system message with the error and stop
 *     │     │
 *     │     └─ ── (no other branch)
 *     │
 *     └─ normal text → submit to engine as a prompt (with attachments
 *                     normally processed)
 *
 * Snapshot semantics
 * ──────────────────
 * The pipeline keeps a per-session HINT cache of extension command names
 * (populated reactively from `engine_command_registry` snapshot events,
 * see `state.ts:extensionCommandRegistry`). The cache is purely an
 * optimisation: cache MISS still dispatches to the engine because the
 * registry may have changed mid-session before the snapshot landed.
 * The engine itself resolves the table live every time, so the cache is
 * never authoritative. The decision tree above does NOT consult the cache
 * — it always dispatches and lets the engine respond. The cache is read
 * by the renderer's autocomplete UI only.
 *
 * File-size posture
 * ─────────────────
 * This file owns the decision tree. The renderer-mutation helpers live in
 * `prompt-pipeline-renderer.ts`. The harness-supplied prose constants live
 * in `prompt-pipeline-prose.ts`. Three files, one feature folder cluster,
 * cohesion preserved: the decision tree stays whole here; only
 * policy-data constants and pure side-effect callees have moved out.
 */

import type { RunOptions } from '../shared/types'
import { IPC } from '../shared/types'

/**
 * Attachment shape carried in remote `prompt`/`engine_prompt` commands.
 * Defined inline because the protocol union (`src/main/remote/protocol.ts`)
 * declares it anonymously per-message; we extract the shape for clarity.
 */
type PipelineAttachment = { type: 'image' | 'file'; name: string; path: string }
import { log as _log } from './logger'
import { state, sessionPlane, engineBridge } from './state'
import { broadcast } from './broadcast'
import { parseSlash, type ParsedSlash } from './slash-parse'
import { dispatchExtensionCommand, tryExpandMarkdownSlash } from './slash-classify'
import { handleLocalClearShortCircuit } from './slash-clear'
import { encodeImageAttachments } from './remote/attachment-encoder'
import type { ImageAttachmentPayload } from '../shared/types'
import { ENTER_PLAN_MODE_DESCRIPTION, PLAN_MODE_SPARSE_REMINDER } from './prompt-pipeline-prose'
import { emitRemoteMessageAdded, insertRendererSystemMessage, clearConnectingStatus } from './prompt-pipeline-renderer'
import { TURN_GROUPING_GUIDANCE } from './turn-grouping-guidance'

export { ENTER_PLAN_MODE_DESCRIPTION, PLAN_MODE_SPARSE_REMINDER } from './prompt-pipeline-prose'

function log(msg: string): void {
  _log('main', msg)
}

/**
 * Origin of the incoming prompt. Drives which echoes we fire:
 *  - 'desktop' : the renderer already inserted the optimistic message bubble
 *                locally via send-slice/engine-slice. We must echo to the
 *                remote transport (iOS) so iOS sees the desktop user's
 *                turn too. We do NOT broadcast back to the renderer.
 *  - 'remote'  : iOS already optimistically inserted the bubble locally.
 *                We must echo to the renderer (so the desktop user sees
 *                the iOS user's turn) AND back to iOS (so iOS replaces
 *                its optimistic entry by id with the canonical timestamp).
 */
export type PromptSource = 'desktop' | 'remote'

/** Input to the unified pipeline. */
export interface IncomingPrompt {
  /** Tab id. For engine tabs this is the tab id only; instanceId is separate. */
  tabId: string
  /** Raw user text, INCLUDING any leading slash or bang prefix. Never expanded. */
  text: string
  /** File / image attachments. Empty array if none. */
  attachments?: PipelineAttachment[]
  /** Image attachments already base64-encoded (from the renderer path) — pass-through. */
  imageAttachments?: ImageAttachmentPayload[]
  /** Client-supplied or generated correlation id, used as the message_added id. */
  reqId: string
  /** Who produced this prompt. See PromptSource. */
  source: PromptSource
  /** True for an engine tab (uses `${tabId}:${instanceId}` session keys). */
  isEngineTab: boolean
  /** Required when isEngineTab is true. Ignored otherwise. */
  instanceId?: string | null
  /** Project working directory; used for `.md` template lookup. */
  projectPath?: string
  /** Engine-tab-only system-prompt append (e.g. voice config). */
  appendSystemPrompt?: string
  /** Optional engine-tab-only model override. */
  model?: string
  /**
   * Suppress EnterPlanMode injection for this run. The desktop sets this
   * when dispatching the "Implement" half of a plan-then-implement flow
   * so the model can't re-propose plan mode against the user's already-
   * approved intent. Forwarded verbatim to engineBridge.sendPrompt; the
   * engine maps it onto RunOptions.ImplementationPhase. See ADR-003
   * framing in the plan-mode docs for why a structured flag beats prompt
   * prose.
   */
  implementationPhase?: boolean
  /** When provided, used verbatim as the RunOptions for CLI submission. The
   *  pipeline mutates `prompt` and `appendSystemPrompt` on this object during
   *  `.md` expansion. */
  runOptions?: RunOptions
  /**
   * Persisted plan file path from tab state. Threaded through to the engine
   * bridge so the engine can restore the plan file after a desktop restart
   * instead of allocating a fresh slug.
   */
  planFilePath?: string
  /**
   * Per-prompt bash-allowlist additions, unioned with the session allowlist
   * for this one run only. Populated by the slash-classify path when a
   * slash command's YAML frontmatter declares `allowed_bash_commands` —
   * the additions are forwarded to engineBridge.sendPrompt so the engine
   * grants the permissions transiently without persisting them on the
   * engineSession allowlist (which would leak across subsequent prompts
   * in the same session). See docs/protocol/client-commands.md
   * § set_plan_mode for the three-layer configuration model.
   */
  bashAllowlistAdditionsForThisPrompt?: string[]
}

/**
 * Compute the engine session key.
 * - CLI tab            → tabId
 * - Engine tab w/ inst → `${tabId}:${instanceId}`
 * - Engine tab w/o inst → tabId (defensive; engine prompt path normally fails earlier)
 */
function engineKey(p: IncomingPrompt): string {
  if (p.isEngineTab && p.instanceId) return `${p.tabId}:${p.instanceId}`
  return p.tabId
}

/**
 * Local `/clear` short-circuit + conversationId resolution live in
 * `slash-clear.ts`. The seam is one-way (handleSlash → slash-clear →
 * engine bridge / renderer helpers), matching the pattern used for
 * `slash-classify.ts`.
 */

/**
 * Handle the `! bash` shortcut for CLI prompts coming from iOS.
 *
 * Desktop's renderer has its own bash mode (a UI toggle in InputBar) so it
 * never reaches the pipeline with a `!`-prefix; this path is the iOS
 * equivalent. Returns true when the text was a bash shortcut and has been
 * dispatched.
 */
function handleBashShortcut(p: IncomingPrompt): boolean {
  if (p.isEngineTab) return false
  if (!p.text.startsWith('!') || p.text.length <= 1) return false
  const bashCmd = p.text.substring(1).trim()
  if (!bashCmd) return false
  log(`pipeline: bash-shortcut tab=${p.tabId} cmd="${bashCmd.substring(0, 40)}"`)
  // Echo the user's typed text back to iOS as a confirmed message so the
  // optimistic entry gets a real timestamp; renderer already has its own
  // entry from send-slice.
  if (p.source === 'remote') {
    emitRemoteMessageAdded(p, `! ${bashCmd}`, 'user')
  }
  broadcast(IPC.REMOTE_BASH_COMMAND, { tabId: p.tabId, command: bashCmd })
  return true
}

/**
 * Submit a regular (non-slash, post-`.md`-expansion, or fall-through) prompt
 * to the engine. The renderer's send-slice / engine-slice already runs by
 * the time we get here for desktop-source prompts (they call IPC.PROMPT
 * which invokes us); for remote-source prompts we go through the renderer
 * broadcast path so the renderer's slice does the optimistic-bubble work.
 *
 * For the CLI path we have a real RunOptions object to pass to
 * sessionPlane.submitPrompt; for the engine path we go through the engine
 * bridge directly.
 */
/**
 * Apply harness-owned system-prompt addenda to the in-flight prompt.
 * Runs at the converging dispatch point so every prompt origin (desktop
 * renderer + iOS CLI/engine, slash + non-slash, fresh + bouncing back
 * from a remote→renderer→IPC roundtrip) gets the same treatment.
 *
 * Today the only addendum is `TURN_GROUPING_GUIDANCE` (see
 * ./turn-grouping-guidance.ts for why). When future harness-level
 * coaching is added, it goes here too — never inject from the
 * renderer or from the slash-expansion path, both of which run on
 * subsets of the prompt population.
 *
 * The append target is split across two fields:
 *
 *   - `p.appendSystemPrompt` — read by the engine-tab terminal
 *     dispatch at `engineBridge.sendPrompt(...)`.
 *   - `p.runOptions?.appendSystemPrompt` — read by the CLI desktop
 *     terminal dispatch at `sessionPlane.submitPrompt(...)`.
 *
 * The slash-expansion path (`handleSlash`) writes both fields to keep
 * them consistent (see lines 438–445), so we mirror that here.
 *
 * Idempotency
 * ───────────
 * The iOS engine path bounces through the renderer once: the first
 * pipeline invocation (source='remote') appends the guidance to
 * `p.appendSystemPrompt`, broadcasts via REMOTE_ENGINE_PROMPT (which
 * forwards `appendSystemPrompt`), the renderer calls back into
 * `window.ion.enginePrompt(...)`, IPC delivers it to the pipeline a
 * second time (source='desktop'), and the helper runs again. Without
 * an idempotency check, the guidance would be appended twice on
 * iOS-originated engine prompts. The `.endsWith()` guard makes the
 * helper safe to call any number of times on the same `p`.
 *
 * The iOS CLI path does not need the guard for its own bounce-back
 * (REMOTE_USER_MESSAGE drops `appendSystemPrompt`), but the guard
 * costs nothing and keeps the helper invariant uniform across paths.
 */
function applyHarnessSystemPromptAddenda(p: IncomingPrompt): void {
  const before = p.appendSystemPrompt?.length ?? 0
  const beforeRun = p.runOptions?.appendSystemPrompt?.length ?? 0
  let didAppendPrimary = false
  let didAppendRun = false

  if (!p.appendSystemPrompt || !p.appendSystemPrompt.endsWith(TURN_GROUPING_GUIDANCE)) {
    p.appendSystemPrompt = p.appendSystemPrompt
      ? `${p.appendSystemPrompt}\n\n${TURN_GROUPING_GUIDANCE}`
      : TURN_GROUPING_GUIDANCE
    didAppendPrimary = true
  }
  if (p.runOptions) {
    const existing = p.runOptions.appendSystemPrompt
    if (!existing || !existing.endsWith(TURN_GROUPING_GUIDANCE)) {
      p.runOptions.appendSystemPrompt = existing
        ? `${existing}\n\n${TURN_GROUPING_GUIDANCE}`
        : TURN_GROUPING_GUIDANCE
      didAppendRun = true
    }
  }

  log(`pipeline: applyHarnessSystemPromptAddenda tab=${p.tabId} ` +
      `engineField=${didAppendPrimary ? `appended (${before}→${p.appendSystemPrompt?.length ?? 0})` : 'already-present (no-op)'} ` +
      `runOptionsField=${p.runOptions ? (didAppendRun ? `appended (${beforeRun}→${p.runOptions.appendSystemPrompt?.length ?? 0})` : 'already-present (no-op)') : 'absent'}`)
}

async function submitAsPrompt(p: IncomingPrompt): Promise<void> {
  // Harness-owned system-prompt addenda are applied here, at the single
  // converging dispatch point. See applyHarnessSystemPromptAddenda for
  // the full reasoning (idempotency, dual-field write, why-not-in-the-
  // renderer). Both terminal dispatches below (engineBridge.sendPrompt
  // for engine tabs, sessionPlane.submitPrompt for CLI tabs) read the
  // updated fields.
  applyHarnessSystemPromptAddenda(p)

  if (p.isEngineTab) {
    const key = engineKey(p)
    log(`pipeline: submit engine prompt key=${key} textLen=${p.text.length}`)
    if (p.source === 'remote') {
      // For remote, we go through the renderer broadcast so the renderer's
      // engine-slice submitEnginePrompt does the optimistic insert + tab
      // status update. The IPC ENGINE_PROMPT handler is the eventual sink.
      broadcast(IPC.REMOTE_ENGINE_PROMPT, {
        tabId: p.tabId,
        text: p.text,
        appendSystemPrompt: p.appendSystemPrompt,
        imageAttachments: p.imageAttachments,
        implementationPhase: p.implementationPhase,
        planFilePath: p.planFilePath,
        // Per-prompt bash-allowlist additions ride the broadcast so the
        // renderer's engine-slice can attach them to its subsequent
        // ENGINE_PROMPT IPC, which lands back in this file via
        // processIncomingPrompt → submitAsPrompt → engineBridge.sendPrompt.
        bashAllowlistAdditionsForThisPrompt: p.bashAllowlistAdditionsForThisPrompt,
      })
      return
    }
    // Desktop-source engine tab: submit directly to the engine bridge.
    // The renderer's submitEnginePrompt has already inserted the optimistic
    // user bubble and set status='running' — we just need to push the prompt
    // through to the engine. This path is reached via IPC.ENGINE_PROMPT
    // (handled in ipc/engine.ts) which delegates here after the unified
    // pipeline has decided the text is not a slash.
    log(`pipeline: submit engine prompt (desktop) key=${key} textLen=${p.text.length}`)
    // ADR-004: always forward the desktop's harness-supplied EnterPlanMode
    // description on auto-mode prompts. Harmless when implementationPhase
    // is true (the engine skips EnterPlanMode injection entirely in that
    // case and the description value goes unused) so the call site stays
    // simple — no branching. Also forward the sparse-reminder override so
    // the per-turn reminder is consistent with the full prompt framing.
    await engineBridge.sendPrompt(key, p.text, p.model, p.appendSystemPrompt, p.imageAttachments, p.implementationPhase, ENTER_PLAN_MODE_DESCRIPTION, PLAN_MODE_SPARSE_REMINDER, p.planFilePath, p.bashAllowlistAdditionsForThisPrompt)
    return
  }

  // CLI path.
  if (p.source === 'remote') {
    // The remote path goes through the renderer broadcast so the renderer's
    // send-slice does the optimistic insert + tab status update. The IPC
    // PROMPT handler is the eventual sink.
    let fullPrompt = p.text
    const attachments = p.attachments || []
    if (attachments.length > 0) {
      const ctx = attachments.map((a) => `[Attached ${a.type}: ${a.path}]`).join('\n')
      fullPrompt = `${ctx}\n\n${fullPrompt}`
    }
    const { encoded, rewrittenText } = encodeImageAttachments(fullPrompt, attachments)
    log(`pipeline: submit cli prompt via REMOTE_USER_MESSAGE tab=${p.tabId} textLen=${rewrittenText.length} encodedImages=${encoded.length}`)
    broadcast(IPC.REMOTE_USER_MESSAGE, {
      tabId: p.tabId,
      requestId: p.reqId,
      prompt: rewrittenText,
      timestamp: Date.now(),
      imageAttachments: encoded.length > 0 ? encoded : undefined,
      implementationPhase: p.implementationPhase,
    })
    return
  }

  // Desktop CLI: submit through the session plane using the renderer-supplied
  // RunOptions. The optimistic bubble already exists from send-slice.
  if (!p.runOptions) {
    log(`pipeline: WARNING desktop-source CLI prompt missing runOptions — cannot submit`)
    return
  }
  // ADR-004: forward the desktop's harness-supplied EnterPlanMode tool
  // description on every CLI engine prompt so the model sees the same
  // framing the desktop-source-engine path uses. The renderer doesn't
  // need to know about this constant — the harness owns it. Don't
  // overwrite a pre-existing override (future power-user paths via
  // settings.json could land an alternate value upstream).
  if (!p.runOptions.enterPlanModeDescription) {
    p.runOptions.enterPlanModeDescription = ENTER_PLAN_MODE_DESCRIPTION
  }
  // Parallel: forward the sparse-reminder override for CLI prompts.
  if (!p.runOptions.planModeSparseReminder) {
    p.runOptions.planModeSparseReminder = PLAN_MODE_SPARSE_REMINDER
  }
  log(`pipeline: submit cli prompt via sessionPlane tab=${p.tabId} req=${p.reqId} promptLen=${p.runOptions.prompt.length}`)
  await sessionPlane.submitPrompt(p.tabId, p.reqId, p.runOptions)
}

/**
 * Handle a parsed slash: try extension command first, fall back to `.md`,
 * else emit "unknown command". Always echoes the user's original slash text
 * to the remote transport so iOS replaces its optimistic entry's bad
 * timestamp with the canonical one.
 *
 * The actual extension-dispatch + `.md` lookup helpers live in
 * `slash-classify.ts`. This function is the orchestrator that decides
 * which to call based on the engine's response shape — it does not own
 * the dispatch mechanics itself.
 */
async function handleSlash(p: IncomingPrompt, slash: ParsedSlash): Promise<void> {
  // Echo the raw slash text to iOS so the optimistic timestamp is corrected
  // (matches Phase 3 of the plan in spirit — even if iOS Phase 3 hasn't been
  // released, the desktop pipeline echoes a canonical ms-timestamp every
  // time a remote prompt is processed).
  if (p.source === 'remote') {
    emitRemoteMessageAdded(p, p.text, 'user')
  }

  const result = await dispatchExtensionCommand(engineKey(p), slash)

  if (result.commandError === '') {
    // Success. Clear the optimistic 'connecting' state because no run will
    // follow for a pure command. (Extensions that DO start a run will set
    // status='running' via run_start before this clear executes, and the
    // clear is a no-op when status isn't 'connecting'.)
    log(`pipeline: ext cmd success key=${engineKey(p)} cmd=/${slash.command}`)
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
    // All other unknown commands continue to the .md expansion path below.
    if (slash.command === 'clear') {
      await handleLocalClearShortCircuit(p, engineKey(p))
      return
    }

    log(`pipeline: engine disclaimed /${slash.command} → trying .md expansion`)
    const expansion = await tryExpandMarkdownSlash(p.tabId, slash, p.projectPath, p.runOptions?.sessionId)
    if (expansion) {
      // Rewrite the in-flight prompt and re-enter submission. The
      // expansion helper returns the new user/system prompts but does
      // NOT mutate the IncomingPrompt itself — keeping the orchestrator
      // as the single mutator of `p` makes the data flow auditable.
      if (p.runOptions) {
        p.runOptions.prompt = expansion.userPrompt
        p.runOptions.appendSystemPrompt = p.runOptions.appendSystemPrompt
          ? p.runOptions.appendSystemPrompt + '\n\n' + expansion.systemPrompt
          : expansion.systemPrompt
      }
      p.text = expansion.userPrompt
      p.appendSystemPrompt = p.appendSystemPrompt
        ? p.appendSystemPrompt + '\n\n' + expansion.systemPrompt
        : expansion.systemPrompt
      // If the expansion specifies allowed bash commands, attach them as
      // per-prompt additions on the IncomingPrompt. The engine unions them
      // with the session-scoped allowlist for this one run only — no
      // session-state mutation, no leak into subsequent prompts. This
      // replaces a previous engineBridge.sendSetPlanMode call that
      // persisted slash-command additions on engineSession.planModeAllowedBashCommands
      // and leaked them across the rest of the session.
      //
      // No need to read the user's persisted global allowlist here — the
      // engine already has it on the session (via the desktop's prior
      // setPermissionMode → set_plan_mode call) and will union it with
      // these additions at run-build time. See
      // docs/protocol/client-commands.md § set_plan_mode for the
      // three-layer configuration model.
      if (expansion.allowedBashCommands && expansion.allowedBashCommands.length > 0) {
        const key = engineKey(p)
        log(`pipeline: frontmatter bash allowlist additions=${expansion.allowedBashCommands.length} key=${key} (per-prompt, no session mutation)`)
        p.bashAllowlistAdditionsForThisPrompt = expansion.allowedBashCommands
      }
      await submitAsPrompt(p)
      return
    }

    log(`pipeline: no .md template for /${slash.command} → emitting unknown-command system message`)
    const msg = `Unknown command: /${slash.command}`
    await insertRendererSystemMessage(p, msg)
    if (p.source === 'remote') emitRemoteMessageAdded(p, msg, 'system')
    await clearConnectingStatus(p)
    return
  }

  // Extension error, timeout, or other failure shape.
  log(`pipeline: ext cmd failed key=${engineKey(p)} cmd=/${slash.command} err=${result.commandError}`)
  const errMsg = result.message || `Command failed: /${slash.command}: ${result.commandError}`
  await insertRendererSystemMessage(p, errMsg)
  if (p.source === 'remote') emitRemoteMessageAdded(p, errMsg, 'system')
  await clearConnectingStatus(p)
}

/**
 * Entry point. Processes one incoming prompt end to end. Idempotent w.r.t.
 * the underlying engine state — calling twice for the same reqId would
 * dispatch twice. Callers (IPC handlers, remote handlers) are expected
 * not to do that.
 *
 * Steps:
 *   1. Normalise the text (light trimming + smart-punctuation flattening
 *      for the remote path; desktop path passes through).
 *   2. Bash shortcut (`!cmd`) — CLI only, remote-source only.
 *   3. Slash branch — see handleSlash().
 *   4. Fall through to normal prompt submission.
 *
 * The function never throws on routing failures — all errors are surfaced
 * as system messages so the user can see them. Real engine submission
 * errors propagate from submitAsPrompt only when the desktop-source CLI
 * path uses sessionPlane.submitPrompt directly (the IPC handler catches
 * and re-throws to the renderer).
 */
export async function processIncomingPrompt(p: IncomingPrompt): Promise<void> {
  // Light text normalisation. For remote-source we also flatten smart
  // punctuation introduced by iOS auto-correct so the engine sees plain
  // ASCII slashes / quotes. Desktop text is taken verbatim because the
  // renderer normalisation already happened.
  const original = p.text
  let text = original
  if (p.source === 'remote') {
    text = text.trim()
      .replace(/—/g, '--')
      .replace(/–/g, '-')
      .replace(/['']/g, "'")
      .replace(/[""]/g, '"')
  }
  p.text = text

  log(`pipeline: processIncomingPrompt source=${p.source} tab=${p.tabId} engine=${p.isEngineTab} reqId=${p.reqId} textLen=${text.length} text="${text.substring(0, 60)}"`)

  // Bash shortcut.
  if (handleBashShortcut(p)) {
    log(`pipeline: handled by bash shortcut, returning`)
    return
  }

  // Slash branch.
  const slash = parseSlash(text)
  if (slash) {
    log(`pipeline: parsed slash command=/${slash.command} hasArgs=${!!slash.args}`)
    await handleSlash(p, slash)
    return
  }

  // Normal prompt.
  log(`pipeline: not a slash, submitting as normal prompt`)
  await submitAsPrompt(p)
}
