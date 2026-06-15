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

function log(msg: string): void {
  _log('main', msg)
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
export async function insertRendererSystemMessage(p: IncomingPrompt, content: string): Promise<void> {
  if (!state.mainWindow) return
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
          // Per-conversation messages now live on the active ConversationInstance
          // in conversationPanes, not on the in-memory TabState. Append the system
          // message onto the active instance, and update the tab status separately.
          var pane = s.conversationPanes ? s.conversationPanes.get('${escapedTab}') : null;
          var inst = pane ? (pane.instances.find(function(i){ return i.id === pane.activeInstanceId; }) || pane.instances[0]) : null;
          var patch = {};
          if (inst) {
            var newMsg = {
              id: 'msg-' + Date.now() + '-' + Math.random(),
              role: 'system',
              content: '${escapedContent}',
              timestamp: Date.now()
            };
            var nextMsgs = (inst.messages || []).concat([newMsg]);
            var nextInst = Object.assign({}, inst, { messages: nextMsgs, messageCount: nextMsgs.length });
            var nextInstances = pane.instances.map(function(i) { return i === inst ? nextInst : i; });
            var nextPanes = new Map(s.conversationPanes);
            nextPanes.set('${escapedTab}', Object.assign({}, pane, { instances: nextInstances }));
            patch.conversationPanes = nextPanes;
          }
          patch.tabs = s.tabs.map(function(t) {
            if (t.id !== '${escapedTab}') return t;
            return Object.assign({}, t, {
              status: t.status === 'connecting' ? 'idle' : t.status
            });
          });
          store.setState(patch);
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
export async function clearConnectingStatus(p: IncomingPrompt): Promise<void> {
  if (!state.mainWindow) return
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
