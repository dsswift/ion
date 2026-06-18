/**
 * engine-history — engine_conversation_history payload builder + broadcaster.
 *
 * Extracted from handlers/engine.ts to keep that file under the 600-line TS
 * cap. Reads an engine instance's message list out of the renderer store and
 * shapes it into the engine_conversation_history wire format, shared by:
 *   - handleLoadEngineConversation (targeted send to one device)
 *   - broadcastEngineHistory (broadcast to all devices after a rewind restart)
 * so both produce byte-identical history payloads.
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
}

/**
 * Read an engine instance's message list out of the renderer store and shape
 * it into the engine_conversation_history wire format. Resolves the active
 * instance when `instanceId` is null (matching the load-conversation default).
 *
 * Returns the resolved `instanceId`, the wire-shaped `messages`, and the
 * `escapedKey` (`tabId:instanceId`) so callers can chain `sendCurrentEngineState`.
 */
export async function readEngineHistoryFromStore(
  tabId: string,
  instanceId: string | null,
): Promise<{ instanceId: string | null; messages: EngineHistoryMessage[]; escapedKey: string }> {
  if (!state.mainWindow) return { instanceId, messages: [], escapedKey: tabId }
  const escapedTab = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const compoundKey = instanceId
    ? `${tabId}:${instanceId}`
    : await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return '${escapedTab}';
        var pane = store.getState().conversationPanes.get('${escapedTab}');
        return pane && pane.activeInstanceId ? '${escapedTab}:' + pane.activeInstanceId : '${escapedTab}';
      })()
    `) || tabId
  const escapedKey = compoundKey.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const messages = (await state.mainWindow.webContents.executeJavaScript(`
    (function() {
      var store = window.__Ion_SESSION_STORE__;
      if (!store) return [];
      var parts = '${escapedKey}'.split(':');
      var tabId = parts[0]; var instId = parts[1];
      var pane = store.getState().conversationPanes.get(tabId);
      var inst = pane && instId ? pane.instances.find(function(i) { return i.id === instId; }) : null;
      var msgs = (inst && inst.messages) || [];
      return msgs.map(function(m) {
        var content = m.content || '';
        if (m.role === 'tool' && content.length > 2048) content = content.substring(0, 2048) + '\\n... [truncated]';
        // Carry dedupKey through to iOS so the data is available on
        // reconnect / history-replay. iOS does not yet act on the key,
        // but having it on the wire lets a future iOS-side dedup
        // implementation match the desktop's behavior without a
        // protocol change.
        var out = { id: m.id, role: m.role, content: content, toolName: m.toolName, toolId: m.toolId, toolStatus: m.toolStatus, timestamp: m.timestamp };
        if (m.dedupKey) out.dedupKey = m.dedupKey;
        return out;
      });
    })()
  `)) as EngineHistoryMessage[] || []
  // Wire-key parse: a compound key carries the instanceId; a bare key (plain
  // conversation) has none. The null-vs-id distinction is intentional here
  // (not parseSessionKey, which would map bare → 'main').
  const resolvedInstanceId = compoundKey.includes(':') ? compoundKey.split(':')[1] : null
  return { instanceId: resolvedInstanceId, messages, escapedKey }
}

/**
 * Broadcast a fresh engine_conversation_history for the given tab/instance to
 * ALL connected remote devices (not a single device). Invoked by the renderer
 * after rewindEngineInstance truncates the instance's messages and restarts
 * the engine session, so connected iOS clients replace their now-stale message
 * list immediately instead of waiting for a sub-tab switch to re-issue
 * load_engine_conversation. iOS's history handler does a full replace, so a
 * broadcast here is sufficient to sync the truncation.
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
    const { instanceId: resolvedInstanceId, messages } = await readEngineHistoryFromStore(tabId, instanceId)
    log(`broadcastEngineHistory: tabId=${tabId} instanceId=${resolvedInstanceId} broadcasting ${messages.length} messages to all devices`)
    state.remoteTransport.send({ type: 'desktop_engine_conversation_history', tabId, instanceId: resolvedInstanceId, messages })
  } catch (err) {
    log(`broadcastEngineHistory error: ${(err as Error).message}`)
  }
}
