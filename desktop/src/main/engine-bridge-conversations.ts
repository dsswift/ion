import type { EngineBridge } from './engine-bridge'
import { log as _log } from './logger'

function log(msg: string): void { _log('engine-bridge', msg) }

/**
 * Conversation-data RPC helpers for the engine bridge.
 *
 * Extracted from engine-bridge.ts to stay under the 600-line file-size
 * cap. These helpers wrap the engine's data-plane RPCs that load,
 * label, migrate, and clear stored conversations — they are
 * connection-aware (each ensures the bridge is connected before
 * dispatching) but they do not touch any other bridge state and have
 * no shared invariant with the streaming event subscription, so they
 * are a natural cohesive seam.
 *
 * Each helper is a thin wrapper around `_sendWithData` / `_sendWithResult`
 * with the request shape pinned to the matching `cmd:` value in
 * engine/internal/server/server.go (and the response shape in
 * engine/internal/server/dispatch_data.go). Keep the cmd strings in
 * sync with the engine — they are the wire-protocol contract, not
 * internal naming.
 *
 * Logging policy: every RPC logs entry at INFO with the resolved
 * identifiers (sessionId / conversationId / provider / limit) so the
 * data-plane traffic is reconstructable from `~/.ion/desktop.log`. The
 * thin wrappers in engine-bridge.ts delegate here directly and do not
 * re-log; double-logging would clutter the trace without adding signal.
 */

export async function listStoredSessions(bridge: EngineBridge, limit?: number): Promise<any[]> {
  await bridge.connect()
  log(`listStoredSessions: limit=${limit ?? 50}`)
  const result = await bridge._sendWithData<any[]>({ cmd: 'list_stored_sessions', limit: limit || 50 })
  return result.data || []
}

export async function loadSessionHistory(bridge: EngineBridge, sessionId: string): Promise<any[]> {
  await bridge.connect()
  log(`loadSessionHistory: sessionId=${sessionId}`)
  const result = await bridge._sendWithData<any[]>({ cmd: 'load_session_history', key: sessionId })
  return result.data || []
}

export async function loadChainHistory(bridge: EngineBridge, sessionIds: string[]): Promise<any[]> {
  await bridge.connect()
  log(`loadChainHistory: count=${sessionIds.length} first=${sessionIds[0] ?? 'none'}`)
  const result = await bridge._sendWithData<any[]>({ cmd: 'load_session_history', sessionIds })
  return result.data || []
}

export async function getConversation(bridge: EngineBridge, conversationId: string, offset = 0, limit = 50): Promise<any> {
  await bridge.connect()
  log(`getConversation: conversationId=${conversationId} offset=${offset} limit=${limit}`)
  const result = await bridge._sendWithData<any>({ cmd: 'get_conversation', key: conversationId, offset, limit })
  const data = result.data || { messages: [], total: 0, hasMore: false }
  log(`getConversation: result conversationId=${conversationId} messages=${data.messages?.length ?? 0} total=${data.total ?? 0}`)
  return data
}

/**
 * Wipes the LLM-visible message history for a stored conversation without
 * requiring a live engine session. Called when /clear is issued on a tab
 * that was loaded from disk but has never sent a prompt (so no engine
 * session exists yet to receive dispatchClear). The conversationId is the
 * session/conversation ID stored on the tab (tab.conversationId).
 *
 * Fields wiped (matches engine dispatchClear): Messages, LastInputTokens,
 * LastInputTokensMsgCount. Entries, cost totals, and identity fields are
 * preserved — /clear is a checkpoint, not a delete.
 */
export async function clearConversationFile(bridge: EngineBridge, conversationId: string): Promise<void> {
  await bridge.connect()
  log(`clearConversationFile: conversationId=${conversationId}`)
  await bridge._sendWithResult({ cmd: 'clear_conversation_file', key: conversationId })
}

export async function saveSessionLabel(bridge: EngineBridge, sessionId: string, label: string): Promise<{ ok: boolean; error?: string }> {
  await bridge.connect()
  log(`saveSessionLabel: sessionId=${sessionId} labelLen=${label.length}`)
  return bridge._sendWithResult({ cmd: 'save_session_label', key: sessionId, label })
}

export async function generateTitle(bridge: EngineBridge, text: string): Promise<string> {
  await bridge.connect()
  log(`generateTitle: textLen=${text.length}`)
  const result = await bridge._sendWithData<{ title: string }>({ cmd: 'generate_title', text })
  return result.data?.title || ''
}

export async function migrateConversation(
  bridge: EngineBridge,
  sessionId: string,
  targetFormat: string,
  targetDir: string,
  sourceDir: string,
): Promise<{ ok: boolean; error?: string; data?: { newSessionId: string; outputPath: string; messageCount: number; contentHash: string } }> {
  await bridge.connect()
  log(`migrateConversation: sessionId=${sessionId} targetFormat=${targetFormat} targetDir=${targetDir} sourceDir=${sourceDir}`)
  return bridge._sendWithData({ cmd: 'migrate_conversation', key: sessionId, text: targetFormat, message: targetDir, args: sourceDir })
}
