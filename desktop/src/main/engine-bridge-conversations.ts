import type { EngineBridge } from './engine-bridge'
import type { DiscoveredCommand, EngineDiscoveredCommand } from '../shared/types'
import { log as _log } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('engine-bridge', msg, fields) }

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
  log('list_stored_sessions', { limit: limit ?? 50 })
  const result = await bridge._sendWithData<any[]>({ cmd: 'list_stored_sessions', limit: limit || 50 })
  return result.data || []
}

export async function loadSessionHistory(bridge: EngineBridge, sessionId: string): Promise<any[]> {
  await bridge.connect()
  log('load_session_history', { session_id: sessionId })
  const result = await bridge._sendWithData<any[]>({ cmd: 'load_session_history', key: sessionId })
  return result.data || []
}

/**
 * Discover filesystem `.md` / skill slash-command templates from the engine.
 *
 * This replaces the desktop's own TS filesystem walk (the retired
 * cli-compat/command-discovery.ts): the engine now OWNS slash resolution, so
 * it is the authority on which templates exist across `.ion/commands`,
 * `.claude/commands`, skills, and project roots. The caller (autocomplete IPC
 * / iOS remote handler) unions this listing with the extension command
 * registry for the menu.
 *
 * `claudeCompat` is the user's "Claude Code Compatibility" setting. The engine
 * gates ALL `.claude` / `~/.claude` roots (commands AND skills) on it: when
 * false, only the `.ion` roots are discovered. The desktop reads the setting
 * and hands it to the engine (the engine holds no opinion on it) via the wire
 * command's optional Config.
 *
 * The engine replies with an array of `{ name, description?, argumentHint?,
 * source? }` where source is one of "extension"|"ion"|"claude"|"skill"|
 * "project". We map it onto the desktop's `DiscoveredCommand` shape so the
 * autocomplete UI can treat engine-discovered templates uniformly. Returns an
 * empty array on any failure (the autocomplete degrades gracefully).
 */
export async function discoverSlashCommands(bridge: EngineBridge, workingDir: string, claudeCompat: boolean): Promise<DiscoveredCommand[]> {
  await bridge.connect()
  log('discover_slash_commands', { path: workingDir, claude_compat: claudeCompat })
  const result = await bridge._sendWithData<EngineDiscoveredCommand[]>({
    cmd: 'discover_slash_commands',
    path: workingDir,
    // The engine reads `claudeCompat` off the optional Config to gate the
    // .claude roots. Only this field is consulted for discovery.
    config: { claudeCompat },
  })
  const raw = result.data || []
  log('discover_slash_commands: done', { path: workingDir, count: raw.length, ok: result.ok })
  return raw.map((c): DiscoveredCommand => {
    // The engine's source taxonomy is richer than the desktop's origin/scope
    // split. Map skills to the skill source; everything else is a command.
    // `.claude` templates map to origin 'claude'; engine discovery does not
    // expose a separate project source because roots share source taxonomy.
    // Note: the claudeCompat GATE is applied engine-side (the engine skips the
    // .claude roots entirely when the flag is false), so anything that arrives
    // here with origin 'claude' was already permitted.
    const source: DiscoveredCommand['source'] = c.source === 'skill' ? 'skill' : 'command'
    const origin: DiscoveredCommand['origin'] = c.source === 'claude' ? 'claude' : 'ion'
    const scope: DiscoveredCommand['scope'] = 'user'
    return {
      name: c.name,
      description: c.description ?? c.argumentHint ?? '',
      scope,
      source,
      origin,
    }
  })
}

export async function loadChainHistory(bridge: EngineBridge, sessionIds: string[]): Promise<any[]> {
  await bridge.connect()
  log('load_chain_history', { count: sessionIds.length })
  const result = await bridge._sendWithData<any[]>({ cmd: 'load_session_history', sessionIds })
  return result.data || []
}

export async function branchSessionBefore(bridge: EngineBridge, key: string, entryId: string): Promise<void> {
  // Tree-native rewind: the engine moves the conversation leaf to the PARENT of
  // the given entry, so the next prompt replaces that entry on the active path
  // instead of chaining after the old leaf (which duplicated the turn when a
  // rewound-and-rebound session re-submitted). Entry-id addressed — for
  // consumers that hold canonical engine entry ids (tree navigator, external).
  await bridge.connect()
  log('branch_before', { key, entry_id: entryId })
  await bridge._sendWithData({ cmd: 'branch_before', key, entryId })
}

export async function rewindSession(bridge: EngineBridge, key: string, target: { entryId?: string; userTurnIndex?: number }): Promise<{ ok: boolean; error?: string }> {
  // Tree-native rewind — the client-facing counterpart to branchSessionBefore.
  // Prefers the exact durable engine entryId when the caller has one (learned
  // from a prior engine_steer_injected confirmation, or from loaded
  // conversation history): the engine validates that id names a genuine user
  // turn on the CURRENT context path before branching, so a stale or
  // foreign-branch id is rejected loudly instead of silently landing on the
  // wrong turn. Falls back to the legacy 0-based user-turn ordinal when no
  // entryId is supplied — the engine resolves that against its own tree the
  // same way it always has. At least one of the two must be present; the
  // caller decides which it has.
  await bridge.connect()
  log('rewind_session', { key, entry_id: target.entryId ?? '', user_turn_index: target.userTurnIndex ?? -1 })
  return bridge._sendWithResult({
    cmd: 'rewind_session',
    key,
    ...(target.entryId ? { entryId: target.entryId } : {}),
    ...(typeof target.userTurnIndex === 'number' ? { userTurnIndex: target.userTurnIndex } : {}),
  })
}

export async function getConversation(bridge: EngineBridge, conversationId: string, offset = 0, limit = 50): Promise<any> {
  await bridge.connect()
  log('get_conversation', { conversation_id: conversationId, offset, limit })
  const result = await bridge._sendWithData<any>({ cmd: 'get_conversation', key: conversationId, offset, limit })
  const data = result.data || { messages: [], total: 0, hasMore: false }
  log('get_conversation: result', { conversation_id: conversationId, messages: data.messages?.length ?? 0, total: data.total ?? 0 })
  return data
}

export async function deleteStoredConversations(
  bridge: EngineBridge,
  sessionIds: string[],
): Promise<{ deleted: number }> {
  await bridge.connect()
  log('delete_stored_conversations', { session_count: sessionIds.length })
  const result = await bridge._sendWithData<{ deleted?: number }>({ cmd: 'delete_stored_conversations', sessionIds })
  return { deleted: result.data?.deleted ?? 0 }
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
  log('clear_conversation_file', { conversation_id: conversationId })
  await bridge._sendWithResult({ cmd: 'clear_conversation_file', key: conversationId })
}

export async function saveSessionLabel(bridge: EngineBridge, sessionId: string, label: string): Promise<{ ok: boolean; error?: string }> {
  await bridge.connect()
  log('save_session_label', { session_id: sessionId, label_len: label.length })
  return bridge._sendWithResult({ cmd: 'save_session_label', key: sessionId, label })
}

export async function generateTitle(bridge: EngineBridge, text: string): Promise<string> {
  await bridge.connect()
  log('generate_title', { text_len: text.length })
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
  log('migrate_conversation', { session_id: sessionId, target_format: targetFormat, target_dir: targetDir, source_dir: sourceDir })
  return bridge._sendWithData({ cmd: 'migrate_conversation', key: sessionId, text: targetFormat, message: targetDir, args: sourceDir })
}
