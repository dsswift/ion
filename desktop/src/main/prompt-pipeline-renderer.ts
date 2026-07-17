/**
 * Side-effect helpers that talk to the renderer and the remote transport;
 * called by the decision tree in prompt-pipeline.ts but not part of its
 * ordering invariants.
 *
 * Splitting rationale
 * ───────────────────
 * prompt-pipeline.ts owns the decision tree. These helpers are pure
 * callees — they never call back into the decision tree and they carry no
 * ordering logic of their own. Moving them here keeps prompt-pipeline.ts
 * focused on control flow and makes the renderer-mutation surface
 * independently reviewable. See the file-size posture section in
 * prompt-pipeline.ts for the full three-file cluster description.
 */

import type { IncomingPrompt } from './prompt-pipeline'
import { log as _log } from './logger'
import { state } from './state'
import { notifyAtvUserMessageEcho } from './atv-window-manager'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

/**
 * Escape a string for safe embedding inside a JS string literal passed
 * to executeJavaScript. Handles backslashes, single-quotes, and newlines.
 * Only needed for executeJavaScript paths; IPC passes structured data
 * without escaping.
 */
function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')
}

/**
 * Send a message_added envelope to iOS via the remote transport. No-op when
 * no transport is connected. The `source` tag controls iOS-side dedupe
 * vs replace semantics (matches `tabs.ts:handlePrompt` legacy shape).
 */
export function emitRemoteMessageAdded(p: IncomingPrompt, content: string, role: 'user' | 'system'): void {
  if (!state.remoteTransport) return
  // For extension-hosted conversations the remote transport has a different envelope shape —
  // engine_harness_message — for system content. User content for extension-hosted
  // conversations is replayed via `engine_conversation_history` on load, so we don't
  // echo individual user message_added events for extension tabs.
  if (p.hasExtensions) {
    if (role === 'system') {
      state.remoteTransport.send({
        type: 'desktop_harness_message',
        tabId: p.tabId,
        instanceId: p.instanceId ?? null,
        message: content,
        source: 'pipeline',
      })
    }
    // No user-role engine echo on this branch: the renderer's unified submit
    // path handles its own optimistic insert for a locally-typed turn, and the
    // remote (iOS) prompt path echoes desktop_message_added itself (see
    // remote/handlers/tabs-prompt.ts). iOS sees an extension-hosted user turn
    // through the full history reload (engine_conversation_history) on
    // conversation load, which is the snapshot authority for persisted turns.
    // The engine does NOT echo user turns back to clients (engine_user_turn was
    // removed); cross-device live echo is owned by the desktop↔iOS wire. There
    // is NO engine_message_added event either — a prior comment here described a
    // mechanism that never existed.
    return
  }
  state.remoteTransport.send({
    type: 'desktop_message_added',
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
 * round-trip.
 *
 * Routes through `addEngineSystemMessage(tabId, content)` for every tab
 * type — the store action resolves the active instance internally. The
 * old two-branch split (compound key for extension tabs, inline store
 * mutation for plain tabs) is gone: Phase 4b collapsed every conversation
 * to a single 'main' instance, so the store action is the single correct
 * path for both.
 */
export async function insertRendererSystemMessage(p: IncomingPrompt, content: string): Promise<void> {
  if (!state.mainWindow) return
  const escapedContent = escape(content)
  const escapedTab = escape(p.tabId)
  try {
    await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return;
        var fn = store.getState().addEngineSystemMessage;
        if (typeof fn !== 'function') return;
        fn('${escapedTab}', '${escapedContent}');
      })()
    `)
  } catch (err) {
    log('prompt_pipeline: insertRendererSystemMessage error', { error: (err as Error).message })
  }
}

/**
 * Insert a user-message bubble into the desktop renderer's per-tab messages
 * for a remote-originated prompt that bypassed the renderer's submit() path.
 *
 * This is the fix for the iOS slash first-message disappearance: when an
 * extension command succeeds synchronously (commandError === ''), the
 * extension's ctx.sendPrompt starts a run, but the desktop pipeline's
 * success path returns without ever calling submit() on the renderer. The
 * renderer store therefore has no user bubble for the prompt, and iOS
 * history reads (which pull from the renderer store) also miss it.
 *
 * Routes through insertRemoteUserMessage(tabId, content, slashCommand?,
 * slashArgs?) on the store, which appends a user message to the active
 * instance without triggering a new prompt to the engine.
 *
 * Also echoes the content to the ATV mirror window via
 * notifyAtvUserMessageEcho so the ATV transcript includes the user turn.
 * Without this echo the ATV shows assistant text with no preceding user
 * bubble for iOS-originated slash commands that resolve as extension
 * commands (commandError === ''). The IPC.PROMPT path fires
 * notifyAtvUserMessageEcho automatically; this path reaches the renderer
 * via executeJavaScript on mainWindow only and therefore needs an explicit
 * echo. notifyAtvUserMessageEcho guards against the ATV window being absent
 * or destroyed, so the call is unconditional here.
 *
 * Note: clearConnectingStatus in this file uses executeJavaScript with an
 * inline store mutation and cannot import the renderer-side setTabStatus
 * helper — that is an intentional cross-process boundary; the inline map
 * is the correct approach there.
 */
export async function insertRendererRemoteUserMessage(
  p: IncomingPrompt,
  content: string,
  slashCommand?: string,
  slashArgs?: string,
): Promise<void> {
  if (!state.mainWindow) return
  const escapedTab = escape(p.tabId)
  const escapedContent = escape(content)
  const escapedSlash = slashCommand ? escape(slashCommand) : ''
  const escapedArgs = slashArgs ? escape(slashArgs) : ''
  try {
    await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return;
        var fn = store.getState().insertRemoteUserMessage;
        if (typeof fn !== 'function') return;
        fn('${escapedTab}', '${escapedContent}'${escapedSlash ? `, '${escapedSlash}', '${escapedArgs}'` : ''});
      })()
    `)
  } catch (err) {
    log('insertRendererRemoteUserMessage error: ' + (err as Error).message)
  }
  // Echo to ATV mirror. The IPC.PROMPT path fires notifyAtvUserMessageEcho
  // automatically; this executeJavaScript path bypasses that channel and
  // needs its own echo so the ATV transcript is complete.
  log('insertRendererRemoteUserMessage: echoing to atv', { tab_id: p.tabId, content_len: content.length })
  notifyAtvUserMessageEcho(p.tabId, content)
}

/**
 * Restore a tab's status to idle when a slash-command dispatch finished
 * (success or failure) without producing a run. The renderer's
 * sendMessage/submitEnginePrompt optimistically set status='connecting' for
 * every prompt; when the unified pipeline determines the dispatch was a
 * pure command (no LLM turn coming), we need to actively clear that
 * connecting state. This is Phase 4 of the unified-pipeline plan.
 */
export async function clearConnectingStatus(p: IncomingPrompt): Promise<void> {
  if (!state.mainWindow) return
  const escapedTab = escape(p.tabId)
  try {
    if (p.hasExtensions) {
      // Extension-hosted tabs use the same tab.status field as plain tabs (set by
      // submitEnginePrompt to 'running'). Reset ONLY 'connecting' to idle —
      // never knock a 'running' tab to idle. A pure slash-command dispatch
      // leaves the tab 'connecting' (no LLM turn coming); but if a real run is
      // already in flight (status 'running'), clearing it would hide the
      // interrupt button and make the tab look idle mid-turn. Mirrors the plain
      // branch below, which already guards on 'connecting' only.
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
    log('prompt_pipeline: clearConnectingStatus error', { error: (err as Error).message })
  }
  // Mirror to iOS so its tab status indicator flips too.
  state.remoteTransport?.send({ type: 'desktop_tab_status', tabId: p.tabId, status: 'idle' })
}
