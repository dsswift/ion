import type { EngineBridge } from './engine-bridge'
import type { DiscoveredCommand, EngineDiscoveredCommand } from '../shared/types'
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
  log(`discoverSlashCommands: path=${workingDir} claudeCompat=${claudeCompat}`)
  const result = await bridge._sendWithData<EngineDiscoveredCommand[]>({
    cmd: 'discover_slash_commands',
    path: workingDir,
    // The engine reads `claudeCompat` off the optional Config to gate the
    // .claude roots. Only this field is consulted for discovery.
    config: { claudeCompat },
  })
  const raw = result.data || []
  log(`discoverSlashCommands: path=${workingDir} count=${raw.length} ok=${result.ok}`)
  return raw.map((c): DiscoveredCommand => {
    // The engine's source taxonomy is richer than the desktop's origin/scope
    // split. Map skills to the skill source; everything else is a command.
    // `.claude`-family templates map to origin 'claude' (preserved as
    // provenance for any consumer that wants to distinguish origin); all others
    // are Ion-native ('ion'). Project-scoped templates report scope 'project'.
    // Note: the claudeCompat GATE is applied engine-side (the engine skips the
    // .claude roots entirely when the flag is false), so anything that arrives
    // here with origin 'claude' was already permitted.
    const source: DiscoveredCommand['source'] = c.source === 'skill' ? 'skill' : 'command'
    const origin: DiscoveredCommand['origin'] = c.source === 'claude' ? 'claude' : 'ion'
    const scope: DiscoveredCommand['scope'] = c.source === 'project' ? 'project' : 'user'
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
