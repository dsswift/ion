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
 *   4. `slash-intercept.ts:interceptEngineSlash` mirrored #3 for extension-hosted conversations.
 *
 * The investigation that produced this module showed that iOS sending
 * `/ion--review-changes 138, 139` silently stalled the conversation because
 * the remote handler routed it as an extension-command (the engine had no
 * such extension command registered) and the `.md` template at
 * `.claude/commands/ion--review-changes.md` was never tried.
 *
 * The structural fix: clients become dumb pipes carrying raw text. All
 * slash-routing policy lives here and is invoked from every entry point
 * (IPC PROMPT, remote handlePrompt, remote
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

/**
 * Attachment shape carried in remote `prompt`/`engine_prompt` commands.
 * Defined inline because the protocol union (`src/main/remote/protocol.ts`)
 * declares it anonymously per-message; we extract the shape for clarity.
 */
type PipelineAttachment = { type: 'image' | 'file'; name: string; path: string }
import { log as _log } from './logger'
import { sessionPlane } from './state'
import { broadcast } from './broadcast'
import { parseSlash, type ParsedSlash } from './slash-parse'
import { handleSlash as handleSlashBranch } from './prompt-pipeline-slash'
import { encodeAttachments } from './remote/attachment-encoder'
import { IS_REMOTE } from './engine-bridge'
import type { ImageAttachmentPayload } from '../shared/types'
import { ENTER_PLAN_MODE_DESCRIPTION, PLAN_MODE_SPARSE_REMINDER } from './prompt-pipeline-prose'
import { emitRemoteMessageAdded } from './prompt-pipeline-renderer'
import { TURN_GROUPING_GUIDANCE } from './turn-grouping-guidance'
import { ASK_USER_QUESTIONS_GUIDANCE } from './questions/questions-tool-decl'
import { notifyQuestionsPromptDispatched, registerQuestionsPromptSink } from './questions/questions-wiring'
import { benchClientWorkspaceContext } from './integration/bench-prompt-context'

export { ENTER_PLAN_MODE_DESCRIPTION, PLAN_MODE_SPARSE_REMINDER } from './prompt-pipeline-prose'

// Hand the guided-questions submitter its dispatch function. This direction
// (pipeline registers INTO questions-wiring) is deliberate: the reverse — the
// submitter importing or requiring this module — is an import cycle that a
// lazy require() papered over in dev and then failed in the packaged app
// ("Cannot find module '../prompt-pipeline'"), breaking every submit.
registerQuestionsPromptSink((prompt) => processIncomingPrompt(prompt))

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
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
  /** Tab id. For extension-hosted conversations this is the tab id only; instanceId is separate. */
  tabId: string
  /** Raw user text, INCLUDING any leading slash or bang prefix. Never expanded. */
  text: string
  /** File / image attachments. Empty array if none. */
  attachments?: PipelineAttachment[]
  /** Image attachments already base64-encoded (from the renderer path) — pass-through. */
  imageAttachments?: ImageAttachmentPayload[]
  /** Client-supplied or generated correlation id, used as the message_added id. */
  reqId: string
  /**
   * How this turn was authored, as an engine InjectionKind wire value.
   * 'structured_answer' marks a Guided Questions submission: delivered to
   * the model, but never rendered as a user bubble (the operator answered in
   * a surface that already shows their answers). Absent for a typed turn.
   */
  injectionKind?: string
  /** Who produced this prompt. See PromptSource. */
  source: PromptSource
  /** True when the conversation hosts extensions (uses `${tabId}:${instanceId}` session keys). */
  hasExtensions: boolean
  /** Required when hasExtensions is true. Ignored otherwise. */
  instanceId?: string | null
  /** Project working directory. Forwarded to the engine for context; the
   *  engine resolves slash templates against its own command roots. */
  projectPath?: string
  /** Extension-hosted conversation system-prompt append (e.g. voice config). */
  appendSystemPrompt?: string
  /** Optional extension-hosted conversation model override. */
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
  /** Run configuration supplied by the renderer. The command path projects the
   *  same fields onto its first and only engine request. */
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
  /** Per-prompt structured workspace context prepared before command routing. */
  clientWorkspaceContext?: import('../shared/types-engine').ClientWorkspaceContext
  resolveSlash?: boolean
  temporaryAutoFromPlan?: boolean
}

/**
 * Compute the engine session key for the wire-bound submit/command path.
 *
 * This key is sent to the engine (sendCommand / sendPrompt). After
 * Phase 4b, all tabs use the bare `tabId` as their engine wire key.
 * The engine treats the key as opaque.
 */
function engineKey(p: IncomingPrompt): string {
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
  if (p.hasExtensions) return false
  if (!p.text.startsWith('!') || p.text.length <= 1) return false
  const bashCmd = p.text.substring(1).trim()
  if (!bashCmd) return false
  log('pipeline: bash shortcut', { tab_id: p.tabId, cmd: bashCmd.substring(0, 40) })
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
 * Submit a regular non-slash or backward-compatible direct-resolve prompt
 * to the engine. The renderer's send-slice / engine-slice already runs
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
 * Addenda are an ORDERED list, each idempotent on its own text: the
 * previous single `.endsWith(TURN_GROUPING_GUIDANCE)` guard could only
 * protect the LAST appended block, so a second addendum would have made
 * the remote bounce-back duplicate the first one. `includes()` per
 * addendum keeps every block append-once no matter how many times the
 * helper runs on the same `p`. The helper now runs before command-vs-prompt
 * routing so every path receives the same addenda exactly once.
 *
 * The append target is split across two fields:
 *
 *   - `p.appendSystemPrompt` — read by the extension-hosted conversation
 *     dispatch at `engineBridge.sendPrompt(...)`.
 *   - `p.runOptions?.appendSystemPrompt` — read by the plain conversation
 *     dispatch at `sessionPlane.submitPrompt(...)`.
 *
 * Idempotency
 * ───────────
 * The iOS engine path bounces through the renderer once: the first
 * pipeline invocation (source='remote') appends the addenda to
 * `p.appendSystemPrompt`, broadcasts via REMOTE_ENGINE_PROMPT (which
 * forwards `appendSystemPrompt`), the renderer calls back into
 * `window.ion.prompt(...)`, IPC delivers it to the pipeline a
 * second time (source='desktop'), and the helper runs again. The
 * per-addendum `includes()` guard makes the helper safe to call any
 * number of times on the same `p`.
 */

/**
 * The harness's system-prompt addenda, in injection order. Each entry is
 * appended exactly once (checked by exact text). Additions go at the end so
 * existing conversations' prompt shapes stay stable.
 */
const SYSTEM_PROMPT_ADDENDA: readonly string[] = [
  TURN_GROUPING_GUIDANCE,
  ASK_USER_QUESTIONS_GUIDANCE,
]

/** Append every missing addendum, in order. Returns the updated text. */
function appendAddenda(existing: string | undefined): { text: string; appended: number } {
  let text = existing ?? ''
  let appended = 0
  for (const addendum of SYSTEM_PROMPT_ADDENDA) {
    if (text.includes(addendum)) continue
    text = text ? `${text}\n\n${addendum}` : addendum
    appended++
  }
  return { text, appended }
}

function applyHarnessSystemPromptAddenda(p: IncomingPrompt): void {
  const before = p.appendSystemPrompt?.length ?? 0
  const beforeRun = p.runOptions?.appendSystemPrompt?.length ?? 0

  // Bench workspace context: when the prompt's project directory is inside an
  // integration bench, send structured bench facts via clientWorkspaceContext
  // so the engine routes them through system_inject and context_inject hooks.
  // The desktop owns the bench, so the desktop owns this data -- the engine
  // injects only the generic worktree context from its own registry.
  let didSetClientWsCtx = false
  const existingWsCtx = p.clientWorkspaceContext ?? p.runOptions?.clientWorkspaceContext
  if (existingWsCtx) {
    p.clientWorkspaceContext = existingWsCtx
    if (p.runOptions && !p.runOptions.clientWorkspaceContext) {
      p.runOptions.clientWorkspaceContext = existingWsCtx
    }
  } else if (p.projectPath) {
    const wsCtx = benchClientWorkspaceContext(p.projectPath)
    if (wsCtx) {
      p.clientWorkspaceContext = wsCtx
      if (p.runOptions) {
        p.runOptions.clientWorkspaceContext = wsCtx
      }
      didSetClientWsCtx = true
    }
  }

  const primary = appendAddenda(p.appendSystemPrompt)
  p.appendSystemPrompt = primary.text
  let runAppended = 0
  if (p.runOptions) {
    const run = appendAddenda(p.runOptions.appendSystemPrompt)
    p.runOptions.appendSystemPrompt = run.text
    runAppended = run.appended
  }

  log('pipeline: applyHarnessSystemPromptAddenda', {
    tab_id: p.tabId,
    engine_field: primary.appended > 0 ? `appended ${primary.appended} (${before}→${p.appendSystemPrompt.length})` : 'already-present (no-op)',
    run_options_field: p.runOptions ? (runAppended > 0 ? `appended ${runAppended} (${beforeRun}→${p.runOptions.appendSystemPrompt?.length ?? 0})` : 'already-present (no-op)') : 'absent',
    client_ws_ctx: didSetClientWsCtx ? p.clientWorkspaceContext?.kind ?? 'set' : 'none',
  })
}

function prepareAttachmentsForDispatch(p: IncomingPrompt): void {
  const attachments = p.attachments ?? []
  if (attachments.length === 0) return
  const sourceText = p.runOptions?.prompt ?? p.text
  const { encoded, rewrittenText } = encodeAttachments(sourceText, attachments, { isRemote: IS_REMOTE })
  p.imageAttachments = [...(p.imageAttachments ?? []), ...encoded]
  if (p.runOptions) {
    p.runOptions.prompt = rewrittenText
    p.runOptions.imageAttachments = [...(p.runOptions.imageAttachments ?? []), ...encoded]
  }
  // The attachment payload is now encoded. Clear raw paths so the ordinary
  // prompt branch cannot encode them again after command classification.
  p.attachments = []
  log('pipeline: attachments prepared before routing', { tab_id: p.tabId, raw: attachments.length, encoded: encoded.length })
}

async function submitAsPrompt(p: IncomingPrompt): Promise<void> {
  // Addenda are applied once at processIncomingPrompt before slash-vs-prompt
  // routing so the first command request receives the same complete context.

  // Remote-source prompts bounce through the renderer once so the renderer's
  // unified `submit` does the optimistic insert + status update; the IPC.PROMPT
  // handler is the eventual sink that re-enters this pipeline as source=desktop.
  // The engine-vs-cli choice here is DATA (does the tab host extensions), which
  // selects which renderer broadcast handler runs — both ultimately call
  // window.ion.prompt and land at the single submitPrompt dispatch below.
  if (p.source === 'remote') {
    if (p.hasExtensions) {
      broadcast(IPC.REMOTE_ENGINE_PROMPT, {
        tabId: p.tabId,
        text: p.text,
        reqId: p.reqId,
        appendSystemPrompt: p.appendSystemPrompt,
        imageAttachments: p.imageAttachments,
        // Forward raw attachments so the renderer's remoteEnginePromptHandler
        // can pass them to submit() and populate the optimistic user message's
        // attachments field. Without this, InlineMessageImages renders nothing
        // and the attachments panel never shows iOS-sent images on the desktop.
        attachments: p.attachments && p.attachments.length > 0 ? p.attachments : undefined,
        implementationPhase: p.implementationPhase,
        thinkingEffort: p.thinkingEffort,
        planFilePath: p.planFilePath,
        bashAllowlistAdditionsForThisPrompt: p.bashAllowlistAdditionsForThisPrompt,
        resolveSlash: p.resolveSlash || undefined,
        temporaryAutoFromPlan: p.temporaryAutoFromPlan || undefined,
        // Client-stated authorship (e.g. 'structured_answer' for a Guided
        // Questions submission). The renderer's submit uses it to skip the
        // optimistic user bubble and forwards it to the engine so the
        // persisted row carries the same classification.
        injectionKind: p.injectionKind,
      })
      return
    }
    let fullPrompt = p.text
    const attachments = p.attachments || []
    if (attachments.length > 0) {
      const ctx = attachments.map((a) => `[Attached ${a.type}: ${a.path}]`).join('\n')
      fullPrompt = `${ctx}\n\n${fullPrompt}`
    }
    const { encoded, rewrittenText } = encodeAttachments(fullPrompt, attachments, { isRemote: IS_REMOTE })
    log('pipeline: submit prompt via remote_user_message', { tab_id: p.tabId, text_len: rewrittenText.length, encoded_images: encoded.length })
    broadcast(IPC.REMOTE_USER_MESSAGE, {
      tabId: p.tabId,
      requestId: p.reqId,
      prompt: rewrittenText,
      timestamp: Date.now(),
      imageAttachments: encoded.length > 0 ? encoded : undefined,
      // Forward raw attachments so the renderer's submitRemotePrompt can
      // populate the optimistic user message's attachments field. Without
      // this, InlineMessageImages renders nothing on the desktop for an
      // iOS-sent image: the rewritten prompt carries only the pathless
      // `[Attachment: NAME (content attached)]` form. Mirrors the
      // REMOTE_ENGINE_PROMPT branch above.
      attachments: attachments.length > 0 ? attachments : undefined,
      implementationPhase: p.implementationPhase,
      resolveSlash: p.resolveSlash,
      temporaryAutoFromPlan: p.temporaryAutoFromPlan,
      injectionKind: p.injectionKind,
    })
    return
  }

  // Desktop-source: ONE terminal dispatch for every conversation tab — plain or
  // extension-backed. The renderer's unified `submit` has already inserted the
  // optimistic user bubble + set status, and always supplies RunOptions
  // (carrying `extensions` for engine-hosted tabs, empty for plain). We route
  // ALL of them through the control plane's submitPrompt — the PREMIUM path
  // that owns session lifecycle (ensureSession, idempotent single start site),
  // remote-working-dir probing, session-loss recovery (re-create + retry), and
  // status transitions. The old extension-tab shortcut (engineBridge.sendPrompt
  // direct) skipped all of that and is gone. submitPrompt → bridge.sendPrompt →
  // the single `send_prompt` wire command for every tab.
  if (!p.runOptions) {
    log('pipeline: WARNING desktop-source prompt missing runOptions', { tab_id: p.tabId })
    return
  }
  // Desktop composer attachments: the renderer prepended [Attached ...]
  // markers into runOptions.prompt and passed the raw paths through
  // (rawAttachments -> p.attachments). Encode them here -- identical
  // treatment to the remote branch above -- so PDFs/images reach the
  // engine as wire bytes instead of client-local path markers.
  const desktopAttachments = p.attachments || []
  if (desktopAttachments.length > 0) {
    const { encoded, rewrittenText } = encodeAttachments(p.runOptions.prompt, desktopAttachments, { isRemote: IS_REMOTE })
    p.runOptions.prompt = rewrittenText
    if (encoded.length > 0) {
      p.runOptions.imageAttachments = [...(p.runOptions.imageAttachments || []), ...encoded]
    }
    log('pipeline: desktop attachments encoded', { tab_id: p.tabId, raw: desktopAttachments.length, encoded: encoded.length })
  }
  if (!p.runOptions.enterPlanModeDescription) {
    p.runOptions.enterPlanModeDescription = ENTER_PLAN_MODE_DESCRIPTION
  }
  if (!p.runOptions.planModeSparseReminder) {
    p.runOptions.planModeSparseReminder = PLAN_MODE_SPARSE_REMINDER
  }
  if (p.resolveSlash) {
    p.runOptions.resolveSlash = true
  }
  log('pipeline: submit prompt', { tab_id: p.tabId, req_id: p.reqId, engine: p.hasExtensions, prompt_len: p.runOptions.prompt.length, resolve_slash: p.resolveSlash ?? false })
  await sessionPlane.submitPrompt(p.tabId, p.reqId, p.runOptions)
}

/** Route one parsed slash command through the engine-owned precedence chain. */
async function handleSlash(p: IncomingPrompt, slash: ParsedSlash): Promise<void> {
  // The slash branch lives in prompt-pipeline-slash.ts (extracted to keep this
  // orchestrator under the file-size cap). It receives only the engine session
  // key seam; command execution and markdown/skill fallback now happen in one
  // engine request.
  await handleSlashBranch(p, slash, { engineKey })
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

  log('pipeline: processIncomingPrompt', { source: p.source, tab_id: p.tabId, engine: p.hasExtensions, req_id: p.reqId, text_len: text.length })

  // Guided-questions lifecycle observer: our own resume prompt completes the
  // submitting workflow; ANY other prompt on the session supersedes its
  // parked questions (the engine clears retained denials on a new prompt, so
  // the workflow could never resume — identical to the AskUserQuestion card).
  notifyQuestionsPromptDispatched(p.tabId, p.reqId)

  // Bash shortcut.
  if (handleBashShortcut(p)) {
    log('pipeline: handled by bash shortcut')
    return
  }

  // Harness-owned system-prompt addenda and attachments apply before
  // command-vs-prompt routing so one-pass commands carry complete context.
  applyHarnessSystemPromptAddenda(p)
  prepareAttachmentsForDispatch(p)

  // resolveSlash short-circuit. When the prompt arrives already flagged for
  // engine-side slash resolution (the iOS legacy direct-prompt slash path bounced back through
  // the renderer → IPC.PROMPT, or a retry of a slash prompt), we MUST NOT
  // re-enter the slash branch: the text is still `/command args`, so
  // re-dispatching it as an extension command would loop. Submit it straight
  // to the engine with resolveSlash=true instead.
  if (p.resolveSlash) {
    log('pipeline: resolveSlash already set, submitting raw')
    await submitAsPrompt(p)
    return
  }

  // Slash branch.
  const slash = parseSlash(text)
  if (slash) {
    log('pipeline: parsed slash command', { command: slash.command, has_args: !!slash.args })
    await handleSlash(p, slash)
    return
  }

  // Normal prompt.
  log('pipeline: not a slash, submitting as normal prompt')
  await submitAsPrompt(p)
}
