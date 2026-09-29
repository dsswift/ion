/**
 * Session and conversation READS -- the shared implementation behind both
 * transports.
 *
 * These functions were the bodies of `ipcMain.handle` registrations in
 * `desktop/src/main/ipc/sessions-list.ts`, which meant they existed only for
 * a client with a preload bridge. A browser Studio client reached them
 * through `host.shell` and got the refusal proxy instead -- opening a
 * conversation threw on `readImageDataUrl` and creating one threw on the
 * sibling `resolveNewConversationDefaults`, both straight into the root
 * error boundary.
 *
 * They are reads over the engine, the conversation store, and the local
 * session archive. Nothing about any of them is Electron-specific, so they
 * live here, next to the state they read, with `sessions-list.ts` reduced to
 * an IPC adapter over this module and `protocol/session-actions.ts` exposing
 * the same functions on the studio-wire.
 *
 * `listSessions`/`listAllSessions` (browsing `~/.claude/projects/`, the
 * separate `claude` CLI's own saved chats, to power the desktop's History
 * Picker) were removed -- the picker itself was disconnected from the UI
 * some time ago in favor of the inbox's settled-conversation history, and
 * the unpartitioned `~/.claude/projects/` directory was a real multi-tenant
 * leak once this module started answering a shared server's requests, not
 * just one desktop's. `loadSession` (below) is unrelated and stays: it
 * loads ONE already-known conversation by id (used by the desktop's
 * permission-denial backfill), not a directory scan.
 */
import { existsSync, readFileSync } from 'fs'
import { log as _log } from '../logger'
import { sessionPlane, engineBridge } from '../state'
import { isValidSessionId, resolveDiscoveryWorkingDir } from '../ipc-validation'
import { conversationExists, loadClaudeSessionMessages, loadEngineConversationMessages } from '../session-meta'
import { loadConversationTranscript } from '../conversation-transcript'
import { readClaudeCompat } from '../persistence/settings-store'
import { pathBasename } from '@ion/shared/paths'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('session-reads', msg, fields)
}

export async function discoverCommands(projectPath: string) {
    log('discover_commands', { path: projectPath })
    try {
      // '~' / empty → user-only discovery (walk ~/.ion, ~/.claude); a present,
      // non-'~' value must be an absolute project root. resolveDiscoveryWorkingDir
      // returns null for a malformed present path.
      const workingDir = resolveDiscoveryWorkingDir(projectPath)
      if (workingDir === null) {
        log('discover_commands: rejected invalid projectPath', { path: projectPath })
        return []
      }
      // The engine OWNS slash resolution + expansion, so it is the authority
      // on which filesystem `.md`/skill templates exist across .ion/commands,
      // .claude/commands, skills, and project roots. Ask it via
      // discover_slash_commands instead of walking the filesystem in TS. The
      // enableClaudeCompat setting gates whether the engine honors the .claude /
      // ~/.claude roots (commands AND skills); the desktop reads the setting and
      // hands it to the engine (which holds no opinion on it). Extension commands
      // (engine_command_registry) are unioned by the renderer's autocomplete UI,
      // not here.
      const claudeCompat = readClaudeCompat()
      const commands = await engineBridge.discoverSlashCommands(workingDir, claudeCompat)
      log('discover_commands: done', { count: commands.length, working_dir: workingDir || '(user-only)', claude_compat: claudeCompat })
      return commands
    } catch (err) {
      log('discover_commands: error', { error: String(err) })
      return []
    }
  }

export async function loadSession(arg: { sessionId: string; projectPath?: string; encodedDir?: string } | string) {
    const sessionId = typeof arg === 'string' ? arg : arg.sessionId
    const projectPath = typeof arg === 'object' ? arg.projectPath : undefined
    const encodedDir = typeof arg === 'object' ? arg.encodedDir : undefined
    log('load_session', { session_id: sessionId })
    try {
      if (!isValidSessionId(sessionId)) {
        log('load_session: rejected invalid sessionId', { session_id: sessionId })
        return []
      }

      // Per-conversation store selection — no global backend mode. An Ion
      // conversation file exists iff the API backend served the conversation
      // (delegated-CLI runs persist only to the CLI's own store, and the
      // engine stamps `backend` on the Ion header). Ion-file-first; fall back
      // to the Claude CLI store only when no Ion file exists.
      if (conversationExists(sessionId)) {
        const msgs = await sessionPlane.loadSessionHistory(sessionId)
        if (msgs && msgs.length > 0) return msgs
        return loadEngineConversationMessages(sessionId)
      }

      const cliMsgs = loadClaudeSessionMessages(sessionId, projectPath, encodedDir)
      if (cliMsgs.length > 0) return cliMsgs

      // Neither store has a file (e.g. a live session before its first save):
      // ask the engine anyway, then the direct file reader as a last resort.
      const msgs = await sessionPlane.loadSessionHistory(sessionId)
      if (msgs && msgs.length > 0) return msgs
      return loadEngineConversationMessages(sessionId)
    } catch (err) {
      log('load_session: error', { error: String(err) })
      try {
        return loadEngineConversationMessages(sessionId)
      } catch {
        return []
      }
    }
  }

export function conversationExistsRead(sessionId: string) {
    // Cheap file-presence probe used by the restore path to skip phantom
    // (fileless, never-saved) conversation ids when resolving which
    // conversation a tab should resume. Returns false for invalid ids.
    if (!isValidSessionId(sessionId)) return false
    return conversationExists(sessionId)
  }

export async function readPlan(filePath: string) {
    try {
      log('read_plan', { path: filePath, exists: filePath ? existsSync(filePath) : false })
      if (!filePath || !existsSync(filePath)) return { content: null, fileName: null }
      const content = readFileSync(filePath, 'utf-8')
      const fileName = pathBasename(filePath)
      log('read_plan: success', { len: content.length })
      return { content, fileName }
    } catch (err) {
      log('read_plan: error', { error: String(err) })
      return { content: null, fileName: null }
    }
  }

/** The largest image embedded in a data URL; anything larger is a bug upstream and would freeze a renderer. */
const IMAGE_DATA_URL_MAX_BYTES = 30 * 1024 * 1024

/**
 * `maxBytes` lowers the size a caller will accept, never raises it. `error`
 * says why there is no image, so a client can tell "too large" from "missing".
 */
export async function readImageDataUrl(filePath: string, opts: { maxBytes?: number } = {}): Promise<{ dataUrl: string | null; error?: string }> {
    try {
      if (!filePath || !existsSync(filePath)) return { dataUrl: null, error: 'File not found' }
      const ext = filePath.toLowerCase()
      const mime =
        ext.endsWith('.png') ? 'image/png' :
        ext.endsWith('.webp') ? 'image/webp' :
        ext.endsWith('.gif') ? 'image/gif' :
        ext.endsWith('.svg') ? 'image/svg+xml' :
        (ext.endsWith('.jpg') || ext.endsWith('.jpeg')) ? 'image/jpeg' :
        null
      if (!mime) return { dataUrl: null, error: 'Unsupported image extension' }
      const limit = typeof opts.maxBytes === 'number' && opts.maxBytes > 0 ? Math.min(Math.floor(opts.maxBytes), IMAGE_DATA_URL_MAX_BYTES) : IMAGE_DATA_URL_MAX_BYTES
      const buf = readFileSync(filePath)
      if (buf.length > limit) {
        log('read_image_data_url: over the size limit', { path: filePath, bytes: buf.length, limit })
        return { dataUrl: null, error: `Image too large (>${limit} bytes)` }
      }
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    } catch (err) {
      log('read_image_data_url: error', { error: String(err) })
      return { dataUrl: null, error: String(err) }
    }
  }

export async function getConversationPage({ conversationId, offset, limit }: { conversationId: string; offset: number; limit: number }) {
    try {
      return await sessionPlane.getConversation(conversationId, offset, limit)
    } catch (err) {
      log('get_conversation: error', { error: String(err) })
      return { messages: [], total: 0, hasMore: false }
    }
  }

export async function deleteStoredConversations(sessionIds: string[]) {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0 || sessionIds.some((id) => !isValidSessionId(id))) {
      throw new Error('invalid conversation IDs')
    }
    try {
      return await engineBridge.deleteStoredConversations(sessionIds)
    } catch (err) {
      log('delete_stored_conversations: error', { count: sessionIds.length, error: String(err) })
      throw err
    }
  }

export async function loadConversationTranscriptForTab(tabId: string) {
    if (typeof tabId !== 'string' || tabId.length === 0 || tabId.length > 256) {
      log('load_conversation_transcript: rejected invalid tab id')
      throw new Error('invalid tab ID')
    }
    return loadConversationTranscript(tabId)
  }

export async function loadChainHistory(sessionIds: string[]) {
    log('load_chain_history', { count: Array.isArray(sessionIds) ? sessionIds.length : 'invalid' })
    try {
      if (!Array.isArray(sessionIds) || sessionIds.some((id) => !isValidSessionId(id))) {
        log('LOAD_CHAIN_HISTORY: rejected invalid sessionIds')
        return []
      }
      const result = await sessionPlane.loadChainHistory(sessionIds)
      log('load_chain_history: done', { messages: result.length, sessions: sessionIds.length })
      return result
    } catch (err) {
      log('load_chain_history: error', { error: String(err) })
      return []
    }
  }
