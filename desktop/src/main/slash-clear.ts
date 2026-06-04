/**
 * Local `/clear` short-circuit + conversation-id resolver.
 *
 * When the user runs `/clear` on a tab that has no live engine session
 * (e.g. a fresh tab, or a tab loaded from disk but never prompted), the
 * engine cannot run `dispatchClear` because no session exists, and it
 * returns `unknown_command`. The desktop intercepts that response and
 * does the equivalent work locally:
 *
 *   1. Resolve the conversation id from the strongest available source
 *      (runOptions → sessionPlane mirror → renderer store).
 *   2. Wipe the on-disk conversation file via the engine bridge so the
 *      LLM does NOT see prior history on the next prompt.
 *   3. Advance the desktop's freshness checkpoint
 *      (`sessionPlane.notifyConversationCleared`) so the next slash
 *      command is treated as the first prompt of a blank session by the
 *      plan→auto guard in slash-classify.ts.
 *   4. Render the clear divider locally on both desktop and remote.
 *
 * Extracted from prompt-pipeline.ts to keep that orchestrator file
 * under the 600-line cap. The helpers here are only called from the
 * `/clear unknown_command` branch in handleSlash.
 *
 * The companion file for the engine-side `/clear` success path is
 * event-wiring.ts, which calls `sessionPlane.notifyConversationCleared`
 * from the `engine_command_result` handler — keeping the freshness
 * checkpoint symmetric across both clear paths.
 */

import { log as _log } from './logger'
import { state, sessionPlane, engineBridge } from './state'
import { formatClearDivider, buildClearDividerRemoteEvent } from '../shared/clear-divider'
import { insertRendererSystemMessage, clearConnectingStatus } from './prompt-pipeline-renderer'
import type { IncomingPrompt } from './prompt-pipeline'

function log(msg: string): void {
  _log('main', msg)
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
 *      where the engine session hasn't started yet (e.g. loaded from disk
 *      but never used). Mirrors the resolveTabProjectPath pattern in
 *      remote/handlers/tabs.ts.
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
 * Local short-circuit for `/clear` when the engine returned
 * `unknown_command` (no live session). Performs the file wipe, advances
 * the freshness checkpoint, and renders the divider locally.
 *
 * The engine session key (CLI: tabId; engine tab: `${tabId}:${instanceId}`)
 * is passed in pre-computed because the helper function that derives it
 * lives in prompt-pipeline.ts; computing it inline here would either
 * duplicate the helper or create an import cycle.
 */
export async function handleLocalClearShortCircuit(p: IncomingPrompt, engineKey: string): Promise<void> {
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
  // Advance the desktop's freshness checkpoint regardless of whether a
  // file wipe was needed. The local short-circuit fires when the engine
  // returns unknown_command (no session yet) — but the tab may still
  // have promptCountSinceCheckpoint > 0 from earlier prompts that did
  // not start an engine session (rare but possible). Calling this
  // unconditionally is cheap and keeps the post-/clear behaviour
  // symmetric with the engine-side success path in event-wiring.ts.
  log(`pipeline: /clear (local short-circuit) notifying conversationCleared tabId=${p.tabId}`)
  sessionPlane.notifyConversationCleared(p.tabId)
  log(`pipeline: /clear unknown_command (no session) → inserting divider locally`)
  const now = new Date()
  const divider = formatClearDivider(now)
  await insertRendererSystemMessage(p, divider)
  state.remoteTransport?.send(buildClearDividerRemoteEvent(engineKey, now))
  await clearConnectingStatus(p)
}
