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
 *     │     │     │   ├─ /clear → local clear short-circuit
 *     │     │     │   └─ otherwise → RE-SUBMIT the raw `/command args` to the
 *     │     │     │       engine with resolveSlash=true. The engine OWNS
 *     │     │     │       resolution + expansion (template lookup across
 *     │     │     │       .ion/commands, .claude/commands, skills, project
 *     │     │     │       roots; $ARGUMENTS + frontmatter), feeds the expanded
 *     │     │     │       body to the model, and persists the RAW invocation
 *     │     │     │       as the displayed user turn. If the engine also can't
 *     │     │     │       resolve it, it emits another unknown_command which
 *     │     │     │       the desktop surfaces as a system message.
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
import { sessionKey, MAIN_INSTANCE_ID } from '../shared/session-key'

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
import { handleSlash as handleSlashBranch } from './prompt-pipeline-slash'
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
  /** Project working directory. Forwarded to the engine for context; the
   *  engine resolves slash templates against its own command roots. */
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
  /** Per-prompt extended-thinking effort. 'off'/undefined → no thinking. Forwarded to sendPrompt + REMOTE_ENGINE_PROMPT. */
  thinkingEffort?: string
  /** When provided, used verbatim as the RunOptions for CLI submission. The
   *  pipeline may mutate `prompt`/`appendSystemPrompt`/`resolveSlash` on this
   *  object on the slash re-submit path (handleSlash). */
  runOptions?: RunOptions
  /**
   * Persisted plan file path from tab state. Threaded through to the engine
   * bridge so the engine can restore the plan file after a desktop restart
   * instead of allocating a fresh slug.
   */
  planFilePath?: string
  /**
   * Per-prompt bash-allowlist additions, unioned with the session allowlist
   * for this one run only. Forwarded to engineBridge.sendPrompt so the engine
   * grants the permissions transiently without persisting them (no leak into
   * subsequent prompts). See docs/protocol/client-commands.md § set_plan_mode.
   * The desktop no longer populates this from slash-command frontmatter —
   * frontmatter handling moved to the engine via resolveSlash — but the field
   * remains for callers that want transient bash grants for a single run.
   */
  bashAllowlistAdditionsForThisPrompt?: string[]
  /**
   * When true, the engine OWNS slash resolution + expansion for this prompt:
   * it treats `text` as a slash invocation, resolves + expands the template
   * across its own command roots, feeds the expanded body to the model, and
   * persists the RAW invocation as the displayed user turn. The desktop sets
   * this only on the re-submit path in `handleSlash` after the engine
   * disclaims a slash with `unknown_command` (local `.md` expansion is
   * retired). Forwarded to `engineBridge.sendPrompt` (engine tabs) /
   * `RunOptions.resolveSlash` (CLI tabs); the wire field is attached only
   * when truthy.
   */
  resolveSlash?: boolean
}

/**
 * Compute the engine session key for the wire-bound submit/command path.
 *
 * This key is sent to the engine (sendCommand / sendPrompt) — it is the
 * engine wire key (Key A), which the DECISION freezes:
 *   - plain conversation (no hosted extension) → bare `tabId` (the
 *     conversation's own engine session identity)
 *   - extension-hosted instance → `${tabId}:${instanceId}`
 * The defensive case (an extension-hosted tab that somehow lacks an
 * instanceId) falls back to the `main` sentinel rather than minting a bare
 * key, so an extension-hosted submit never collides with the plain-
 * conversation key space.
 */
function engineKey(p: IncomingPrompt): string {
  if (!p.isEngineTab) return p.tabId
  return sessionKey(p.tabId, p.instanceId ?? MAIN_INSTANCE_ID)
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
 * Submit a regular (non-slash, slash-resolve re-submit, or fall-through)
 * prompt to the engine. The renderer's send-slice / engine-slice already runs
 * by the time we get here for desktop-source prompts (they call IPC.PROMPT
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
 * renderer or from the slash re-submit path, both of which run on
 * subsets of the prompt population.
 *
 * The append target is split across two fields:
 *
 *   - `p.appendSystemPrompt` — read by the engine-tab terminal
 *     dispatch at `engineBridge.sendPrompt(...)`.
 *   - `p.runOptions?.appendSystemPrompt` — read by the CLI desktop
 *     terminal dispatch at `sessionPlane.submitPrompt(...)`.
 *
 * The slash re-submit path (`handleSlash`) writes both fields to keep
 * them consistent, so we mirror that here.
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
        thinkingEffort: p.thinkingEffort,
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
    await engineBridge.sendPrompt(key, p.text, p.model, p.appendSystemPrompt, p.imageAttachments, p.implementationPhase, ENTER_PLAN_MODE_DESCRIPTION, PLAN_MODE_SPARSE_REMINDER, p.planFilePath, p.bashAllowlistAdditionsForThisPrompt, p.thinkingEffort, p.resolveSlash)
    return
  }

  // Plain-conversation path (no engine extension hosted in the conversation).
  // Routes through the control plane keyed by bare tabId — the engine wire key
  // is the conversation's own identity, unaffected by the renderer's internal
  // `${tabId}:main` pane-addressing convention.
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
      // Carry the engine-resolve-slash flag through the renderer bounce so
      // the iOS slash re-submit reaches the engine with resolveSlash=true
      // (the renderer's submitRemotePrompt forwards it onto RunOptions, which
      // lands back here via IPC.PROMPT → submitAsPrompt). Absent/false for
      // ordinary remote prompts.
      resolveSlash: p.resolveSlash,
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
  // Forward the engine-resolve-slash flag onto RunOptions so the control
  // plane's submitPrompt → bridge.sendPrompt passes it through. Set on the
  // re-submit path in handleSlash; absent/false on ordinary prompts.
  if (p.resolveSlash) {
    p.runOptions.resolveSlash = true
  }
  log(`pipeline: submit cli prompt via sessionPlane tab=${p.tabId} req=${p.reqId} promptLen=${p.runOptions.prompt.length} resolveSlash=${p.resolveSlash ?? false}`)
  await sessionPlane.submitPrompt(p.tabId, p.reqId, p.runOptions)
}

/**
 * Out-of-band: surface a system message when the ENGINE also fails to resolve
 * the slash on the resolveSlash re-submit. The engine emits
 * engine_command_result{unknown_command} only on a resolve FAILURE (success
 * starts a run → no command result), so we act only on unknown_command;
 * timeout (the success outcome) and any other shape are ignored. The re-submit
 * does not block on this. Errors are logged, never thrown.
 */
async function handleSlash(p: IncomingPrompt, slash: ParsedSlash): Promise<void> {
  // The slash branch lives in prompt-pipeline-slash.ts (extracted to keep this
  // orchestrator under the file-size cap). It needs two orchestrator-local
  // helpers — engineKey + submitAsPrompt — which we inject so the seam stays
  // one-way (slash module never imports back into this file at runtime).
  await handleSlashBranch(p, slash, { engineKey, submitAsPrompt })
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

  // resolveSlash short-circuit. When the prompt arrives already flagged for
  // engine-side slash resolution (the iOS slash re-submit bounced back through
  // the renderer → IPC.PROMPT, or a retry of a slash prompt), we MUST NOT
  // re-enter the slash branch: the text is still `/command args`, so
  // re-dispatching it as an extension command would loop. Submit it straight
  // to the engine with resolveSlash=true instead.
  if (p.resolveSlash) {
    log(`pipeline: resolveSlash already set (re-submit/retry) → submitting raw invocation directly, skipping slash dispatch`)
    await submitAsPrompt(p)
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
