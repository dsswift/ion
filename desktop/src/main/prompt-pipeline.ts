// @file-size-exception: unified decision tree must remain a single file (see file-size posture section below)
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
 * Target ≤ 600 lines. The module is intentionally a single file because
 * the decision tree is the contract — splitting it across files would
 * obscure the ordering invariants that make the precedence rules work.
 */

import type { RunOptions } from '../shared/types'
import { IPC } from '../shared/types'
import { formatClearDivider, buildClearDividerRemoteEvent } from '../shared/clear-divider'

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
import { awaitCommandResult, type CommandResult } from './command-await'
import { expandSlashCommand } from './cli-compat/slash-expand'
import { readSettings, SETTINGS_DEFAULTS } from './settings-store'
import { encodeImageAttachments } from './remote/attachment-encoder'
import type { ImageAttachmentPayload } from '../shared/types'

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
  /** When provided, used verbatim as the RunOptions for CLI submission. The
   *  pipeline mutates `prompt` and `appendSystemPrompt` on this object during
   *  `.md` expansion. */
  runOptions?: RunOptions
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
 * Send a message_added envelope to iOS via the remote transport. No-op when
 * no transport is connected. The `source` tag controls iOS-side dedupe
 * vs replace semantics (matches `tabs.ts:handlePrompt` legacy shape).
 */
function emitRemoteMessageAdded(p: IncomingPrompt, content: string, role: 'user' | 'system'): void {
  if (!state.remoteTransport) return
  // For engine tabs the remote transport has a different envelope shape —
  // engine_harness_message — for system content. User content for engine
  // tabs is replayed via `engine_conversation_history` on load, so we don't
  // echo individual user message_added events for engine tabs.
  if (p.isEngineTab) {
    if (role === 'system') {
      state.remoteTransport.send({
        type: 'engine_harness_message',
        tabId: p.tabId,
        instanceId: p.instanceId ?? null,
        message: content,
        source: 'pipeline',
      })
    }
    // No user-role engine echo here — the renderer's submitEnginePrompt
    // path handles its own optimistic insert; iOS sees the agent activity
    // via engine_message_added events that come back from the engine
    // bridge once the prompt actually runs.
    return
  }
  state.remoteTransport.send({
    type: 'message_added',
    tabId: p.tabId,
    message: {
      // Reuse the request id ONLY for the user echo so iOS replaces its
      // optimistic bubble by id (the canonical ms timestamp shipped here
      // is what fixes the "56 years ago" symptom). System echoes need a
      // distinct id, otherwise iOS treats them as edits of the user's
      // turn and overwrites the user bubble — which is what produced the
      // regression where a slash failure visibly "deleted" the user's
      // message and replaced it with the error text.
      id: role === 'system' ? `sys-${p.reqId}-${Date.now()}` : p.reqId,
      role,
      content,
      timestamp: Date.now(),
      source: p.source,
    },
  })
}

/**
 * Insert a system-message bubble into the desktop renderer's per-tab
 * messages. Lets the unified pipeline surface unknown-command feedback,
 * extension-command failures, and timeouts without going through an LLM
 * round-trip. Engine and CLI tabs use different store mutators so we
 * branch on isEngineTab.
 */
async function insertRendererSystemMessage(p: IncomingPrompt, content: string): Promise<void> {
  if (!state.mainWindow) return
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')
  const escapedContent = escape(content)
  try {
    if (p.isEngineTab) {
      if (!p.instanceId) return
      const key = `${p.tabId}:${p.instanceId}`
      const escapedKey = escape(key)
      await state.mainWindow.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return;
          var fn = store.getState().addEngineSystemMessage;
          if (typeof fn !== 'function') return;
          fn('${escapedKey}', '${escapedContent}');
        })()
      `)
    } else {
      const escapedTab = escape(p.tabId)
      await state.mainWindow.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return;
          var s = store.getState();
          store.setState({
            tabs: s.tabs.map(function(t) {
              if (t.id !== '${escapedTab}') return t;
              return Object.assign({}, t, {
                status: t.status === 'connecting' ? 'idle' : t.status,
                messages: t.messages.concat([{
                  id: 'msg-' + Date.now() + '-' + Math.random(),
                  role: 'system',
                  content: '${escapedContent}',
                  timestamp: Date.now()
                }])
              });
            })
          });
        })()
      `)
    }
  } catch (err) {
    log(`insertRendererSystemMessage error: ${(err as Error).message}`)
  }
}

/**
 * Restore a tab's status to idle when a slash-command dispatch finished
 * (success or failure) without producing a run. The renderer's
 * sendMessage/submitEnginePrompt optimistically set status='connecting' for
 * every prompt; when the unified pipeline determines the dispatch was a
 * pure command (no LLM turn coming), we need to actively clear that
 * connecting state. This is Phase 4 of the unified-pipeline plan.
 */
async function clearConnectingStatus(p: IncomingPrompt): Promise<void> {
  if (!state.mainWindow) return
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const escapedTab = escape(p.tabId)
  try {
    if (p.isEngineTab) {
      // Engine tabs use the same tab.status field as CLI tabs (set by
      // submitEnginePrompt to 'running'). Reset it the same way.
      await state.mainWindow.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return;
          var s = store.getState();
          store.setState({
            tabs: s.tabs.map(function(t) {
              if (t.id !== '${escapedTab}') return t;
              if (t.status !== 'connecting' && t.status !== 'running') return t;
              return Object.assign({}, t, { status: 'idle' });
            })
          });
        })()
      `)
    } else {
      await state.mainWindow.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return;
          var s = store.getState();
          store.setState({
            tabs: s.tabs.map(function(t) {
              if (t.id !== '${escapedTab}') return t;
              if (t.status !== 'connecting') return t;
              return Object.assign({}, t, { status: 'idle' });
            })
          });
        })()
      `)
    }
  } catch (err) {
    log(`clearConnectingStatus error: ${(err as Error).message}`)
  }
  // Mirror to iOS so its tab status indicator flips too.
  state.remoteTransport?.send({ type: 'tab_status', tabId: p.tabId, status: 'idle' })
}

/**
 * Resolve the conversationId for a tab from the strongest available source.
 *
 * Priority (first non-null wins):
 *   1. p.runOptions?.sessionId — desktop /clear carries this for free; no
 *      IPC roundtrip required.
 *   2. sessionPlane.getTabStatus(tabId)?.conversationId — the engine-side
 *      mirror populated by engine_status events. Available once any session
 *      has started on this tab. Kept as a defensive fallback for code paths
 *      that construct IncomingPrompt without runOptions.
 *   3. Renderer-store query via executeJavaScript — reads tab.conversationId
 *      directly from `window.__Ion_SESSION_STORE__` in the renderer process.
 *      This is the safety net for remote-source /clear (iOS) and any path
 *      where neither of the above has been populated yet (e.g. a tab loaded
 *      from disk but never used). Mirrors the resolveTabProjectPath pattern
 *      in remote/handlers/tabs.ts.
 *
 * Returns null when all three sources are null (the tab is truly fresh).
 */
async function resolveConversationId(p: IncomingPrompt): Promise<{ id: string; via: string } | null> {
  // Priority 1: runOptions.sessionId (desktop path, already in the envelope).
  const fromRunOptions = p.runOptions?.sessionId ?? null
  if (fromRunOptions) {
    return { id: fromRunOptions, via: 'runOptions' }
  }

  // Priority 2: engine-side mirror (populated after engine_status fires).
  const fromSessionPlane = sessionPlane.getTabStatus(p.tabId)?.conversationId ?? null
  if (fromSessionPlane) {
    return { id: fromSessionPlane, via: 'sessionPlane' }
  }

  // Priority 3: renderer-store query (iOS / loaded-but-not-started tab).
  if (!state.mainWindow) return null
  try {
    const escapedTab = p.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const fromRenderer = await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        var tab = store.getState().tabs.find(function(t) { return t.id === '${escapedTab}'; });
        return tab && tab.conversationId ? tab.conversationId : null;
      })()
    `)
    if (fromRenderer) {
      return { id: String(fromRenderer), via: 'renderer-store' }
    }
  } catch (err) {
    log(`pipeline: resolveConversationId renderer-store query failed tab=${p.tabId} err=${String(err)}`)
  }

  return null
}

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
async function submitAsPrompt(p: IncomingPrompt): Promise<void> {
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
    await engineBridge.sendPrompt(key, p.text, p.model, p.appendSystemPrompt, p.imageAttachments)
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
    })
    return
  }

  // Desktop CLI: submit through the session plane using the renderer-supplied
  // RunOptions. The optimistic bubble already exists from send-slice.
  if (!p.runOptions) {
    log(`pipeline: WARNING desktop-source CLI prompt missing runOptions — cannot submit`)
    return
  }
  log(`pipeline: submit cli prompt via sessionPlane tab=${p.tabId} req=${p.reqId} promptLen=${p.runOptions.prompt.length}`)
  await sessionPlane.submitPrompt(p.tabId, p.reqId, p.runOptions)
}

/**
 * Attempt `.md` template expansion for the parsed slash. On success, mutates
 * the prompt text (and runOptions for the CLI path) to the expanded prompt
 * and auto-switches the tab's permission mode to 'auto', then re-enters
 * the pipeline at submitAsPrompt. Returns true when expansion occurred.
 */
async function tryMarkdownExpansion(p: IncomingPrompt, slash: ParsedSlash): Promise<boolean> {
  let claudeCompat = SETTINGS_DEFAULTS.enableClaudeCompat
  try {
    const s = readSettings()
    claudeCompat = s.enableClaudeCompat ?? claudeCompat
  } catch { /* default */ }
  if (!claudeCompat) {
    log(`pipeline: .md expansion disabled by settings, name=${slash.command}`)
    return false
  }

  const rebuilt = '/' + slash.command + (slash.args ? ' ' + slash.args : '')
  const expansion = await expandSlashCommand(rebuilt, p.projectPath)
  if (!expansion.expanded) {
    log(`pipeline: no .md expansion for /${slash.command}`)
    return false
  }
  log(`pipeline: .md expanded /${slash.command} → userLen=${expansion.userPrompt.length} sysLen=${expansion.systemPrompt.length}`)

  // Auto-switch permission mode to 'auto' (matches legacy applySlashExpansion).
  sessionPlane.setPermissionMode(p.tabId, 'auto', 'slash_command')
  broadcast(IPC.REMOTE_SET_PERMISSION_MODE, { tabId: p.tabId, mode: 'auto' })

  // Rewrite the in-flight prompt. For the CLI desktop path, runOptions is the
  // canonical struct submitPrompt will read, so mutate it.
  if (p.runOptions) {
    p.runOptions.prompt = expansion.userPrompt
    p.runOptions.appendSystemPrompt = p.runOptions.appendSystemPrompt
      ? p.runOptions.appendSystemPrompt + '\n\n' + expansion.systemPrompt
      : expansion.systemPrompt
  }
  // Also keep IncomingPrompt's view in sync for the remote-broadcast path.
  p.text = expansion.userPrompt
  p.appendSystemPrompt = p.appendSystemPrompt
    ? p.appendSystemPrompt + '\n\n' + expansion.systemPrompt
    : expansion.systemPrompt

  await submitAsPrompt(p)
  return true
}

/**
 * Dispatch a parsed slash command to the engine and await the result. The
 * engine resolves the command table live at dispatch time so we never need
 * to check our snapshot cache here — we let the engine be authoritative
 * and react to the response shape.
 *
 * Returns the CommandResult so the caller can decide what to do next:
 *   - commandError === ""               → engine ran the command, done
 *   - commandError === "unknown_command" → fall through to .md expansion
 *   - any other commandError            → surface as system message
 */
async function dispatchAsExtensionCommand(p: IncomingPrompt, slash: ParsedSlash): Promise<CommandResult> {
  const key = engineKey(p)
  log(`pipeline: dispatch ext cmd key=${key} cmd=/${slash.command} hasArgs=${!!slash.args}`)
  // Register awaiter BEFORE issuing the dispatch so we never miss the event
  // even on the local-process fast path. awaitCommandResult attaches the
  // global listener idempotently.
  const waiter = awaitCommandResult(key, slash.command)
  void engineBridge.sendCommand(key, slash.command, slash.args)
  const result = await waiter
  log(`pipeline: ext cmd resolved key=${key} cmd=/${slash.command} err=${result.commandError || '(none)'}`)
  return result
}

/**
 * Handle a parsed slash: try extension command first, fall back to `.md`,
 * else emit "unknown command". Always echoes the user's original slash text
 * to the remote transport so iOS replaces its optimistic entry's bad
 * timestamp with the canonical one.
 */
async function handleSlash(p: IncomingPrompt, slash: ParsedSlash): Promise<void> {
  // Echo the raw slash text to iOS so the optimistic timestamp is corrected
  // (matches Phase 3 of the plan in spirit — even if iOS Phase 3 hasn't been
  // released, the desktop pipeline echoes a canonical ms-timestamp every
  // time a remote prompt is processed).
  if (p.source === 'remote') {
    emitRemoteMessageAdded(p, p.text, 'user')
  }

  const result = await dispatchAsExtensionCommand(p, slash)

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
      // If the tab has a tracked conversationId (loaded from disk but never
      // sent a prompt), wipe the on-disk conversation file so the LLM does
      // NOT see the prior history on the next prompt. Without this step the
      // divider is only visual — the engine would still load and forward all
      // 495+ messages on the next start_session.
      //
      // We consult three sources in priority order (see resolveConversationId)
      // because the engine-side mirror (sessionPlane) is only populated after
      // a session starts — a tab loaded from disk but never prompted has
      // tab.conversationId in the renderer but NOT in the engine-control-plane.
      const resolved = await resolveConversationId(p)
      if (resolved) {
        const { id: convId, via } = resolved
        log(`pipeline: /clear conversationId resolved via=${via} id=${convId}`)
        try {
          await engineBridge.clearConversationFile(convId)
          log(`pipeline: /clear on-disk wipe complete conversationId=${convId}`)
        } catch (err) {
          // Log and continue: the divider is still inserted so the user sees
          // the expected UI feedback. The wipe failure is non-fatal — worse
          // than the bug, but not a crash. The user can /clear again.
          log(`pipeline: /clear on-disk wipe failed conversationId=${convId} err=${String(err)}`)
        }
      } else {
        log(`pipeline: /clear no conversationId from any source — truly fresh tab`)
      }
      log(`pipeline: /clear unknown_command (no session) → inserting divider locally`)
      const now = new Date()
      const divider = formatClearDivider(now)
      await insertRendererSystemMessage(p, divider)
      state.remoteTransport?.send(buildClearDividerRemoteEvent(engineKey(p), now))
      await clearConnectingStatus(p)
      return
    }

    log(`pipeline: engine disclaimed /${slash.command} → trying .md expansion`)
    const expanded = await tryMarkdownExpansion(p, slash)
    if (expanded) return

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
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
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
