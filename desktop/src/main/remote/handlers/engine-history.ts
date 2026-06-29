/**
 * engine-history — engine conversation history broadcaster.
 *
 * Extracted from handlers/engine.ts to keep that file under the 600-line TS
 * cap. Reads an engine instance's message list out of the renderer store and
 * broadcasts the unified desktop_conversation_history wire format to all
 * connected devices after a rewind restart.
 *
 * handleLoadEngineConversation is retired (WI-004 / #259). The history read
 * path is now unified: desktop_load_conversation handles every tab; the
 * response is always desktop_conversation_history. broadcastEngineHistory
 * uses the same response type so rewind broadcasts are also unified.
 */

import { log as _log } from '../../logger'
import { state } from '../../state'

function log(msg: string): void {
  _log('main', msg)
}

/** Wire shape of one message in an engine_conversation_history payload.
 *  Mirrors the inline type on the RemoteEvent variant in protocol.ts. */
export interface EngineHistoryMessage {
  id: string
  role: string
  content: string
  toolName?: string
  toolId?: string
  toolStatus?: string
  timestamp: number
  dedupKey?: string
  /** Plan path on plan-lifecycle divider system messages, so the slug stays
   * clickable on iOS after a history reload. Omitted on non-divider messages. */
  planFilePath?: string
}

/**
 * Read an engine instance's message list out of the renderer store. Resolves
 * the active instance when `instanceId` is null (matching the load-conversation
 * default). Used by broadcastEngineHistory after a rewind restart.
 *
 * Returns the resolved `instanceId` and the wire-shaped `messages`.
 */
export async function readEngineHistoryFromStore(
  tabId: string,
  instanceId: string | null,
): Promise<{ instanceId: string | null; messages: EngineHistoryMessage[] }> {
  if (!state.mainWindow) return { instanceId, messages: [] }
  const escapedTab = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const escapedInst = instanceId ? instanceId.replace(/\\/g, '\\\\').replace(/'/g, "\\'") : ''
  const result = (await state.mainWindow.webContents.executeJavaScript(`
    (function() {
      var store = window.__Ion_SESSION_STORE__;
      if (!store) return { resolvedId: null, messages: [] };
      var pane = store.getState().conversationPanes.get('${escapedTab}');
      if (!pane) return { resolvedId: null, messages: [] };
      // Resolve the target instance:
      //   1. If a specific instanceId was passed in, find it directly.
      //   2. Otherwise (bare-key, post-#256 path) use the pane's activeInstanceId,
      //      falling back to the first instance (always 'main' after #256).
      var instId = '${escapedInst}';
      var inst = instId
        ? pane.instances.find(function(i) { return i.id === instId; })
        : pane.instances.find(function(i) { return i.id === pane.activeInstanceId; }) || pane.instances[0] || null;
      var resolvedId = inst ? inst.id : null;
      var msgs = (inst && inst.messages) || [];
      var mapped = msgs.map(function(m) {
        var content = m.content || '';
        if (m.role === 'tool' && content.length > 2048) content = content.substring(0, 2048) + '\\n... [truncated]';
        // Carry dedupKey through to iOS so the data is available on
        // reconnect / history-replay. iOS does not yet act on the key,
        // but having it on the wire lets a future iOS-side dedup
        // implementation match the desktop's behavior without a
        // protocol change.
        var out = { id: m.id, role: m.role, content: content, toolName: m.toolName, toolId: m.toolId, toolStatus: m.toolStatus, timestamp: m.timestamp };
        if (m.dedupKey) out.dedupKey = m.dedupKey;
        // Carry planFilePath through so plan-lifecycle divider system messages
        // (Plan created / Plan updated / Implementing plan) stay clickable on
        // iOS after a history reload — iOS reads it from the desktop store via
        // this mapper, the same store the live handlers populate.
        if (m.planFilePath) out.planFilePath = m.planFilePath;
        return out;
      });
      return { resolvedId: resolvedId, messages: mapped };
    })()
  `)) as { resolvedId: string | null; messages: EngineHistoryMessage[] } | null
  const resolvedInstanceId = result?.resolvedId ?? null
  const messages = result?.messages ?? []
  return { instanceId: resolvedInstanceId, messages }
}

/**
 * Broadcast a fresh conversation history for the given tab to ALL connected
 * remote devices (not a single device). Invoked by the renderer after
 * rewindEngineInstance truncates the instance's messages and restarts the
 * engine session, so connected iOS clients replace their now-stale message
 * list immediately instead of waiting for a sub-tab switch to re-issue
 * load_conversation. Uses the unified desktop_conversation_history wire type
 * (WI-004 / #259) — the same response the load_conversation handler sends.
 */
export async function broadcastEngineHistory(tabId: string, instanceId: string | null): Promise<void> {
  if (!state.remoteTransport) {
    log(`broadcastEngineHistory: no remote transport; skipping tabId=${tabId} instanceId=${instanceId || 'null'}`)
    return
  }
  if (!state.mainWindow) {
    log(`broadcastEngineHistory: no main window; skipping tabId=${tabId} instanceId=${instanceId || 'null'}`)
    return
  }
  try {
    const { messages } = await readEngineHistoryFromStore(tabId, instanceId)
    log(`broadcastEngineHistory: tabId=${tabId} broadcasting ${messages.length} messages to all devices`)
    // Use the unified desktop_conversation_history response type. The hasMore
    // flag is false because a post-rewind broadcast sends all messages; the
    // client replaces its message list wholesale on history receipt.
    // Cast messages to RemoteMessage[]: EngineHistoryMessage is a compatible
    // subset (same fields; role is string, RemoteMessage.role is a narrower
    // union — the engine always sends valid role values).
    state.remoteTransport.send({ type: 'desktop_conversation_history', tabId, messages: messages as any, hasMore: false })
  } catch (err) {
    log(`broadcastEngineHistory error: ${(err as Error).message}`)
  }
}
