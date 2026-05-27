import { EventEmitter } from 'events'
import { createConnection, Socket } from 'net'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log as _log, debug as _debug, warn as _warn, error as _error } from './logger'
import { spawnEngineServer } from './engine-bridge-spawn'
import { startSession as startSessionImpl } from './engine-bridge-start-session'
import * as conv from './engine-bridge-conversations'
import type { EngineConfig, EngineEvent, ImageAttachmentPayload } from '../shared/types'

const TAG = 'EngineBridge'
function log(msg: string): void { _log(TAG, msg) }
function debug(msg: string): void { _debug(TAG, msg) }
function warn(msg: string): void { _warn(TAG, msg) }
function error(msg: string): void { _error(TAG, msg) }

const ION_HOME = join(homedir(), '.ion')
const SOCKET_PATH = join(ION_HOME, 'desktop.sock')
const PID_PATH = join(ION_HOME, 'desktop.pid')

/**
 * When ION_DESKTOP_ENGINE_SOCKET is set to "host:port", the bridge connects
 * over TCP to a remote engine instead of spawning a local one. Reconnect on
 * disconnect is automatic with exponential backoff (500 ms → 8 s, then 30 s cap).
 */
export const REMOTE_SOCKET = process.env.ION_DESKTOP_ENGINE_SOCKET || ''
export const IS_REMOTE = REMOTE_SOCKET.includes(':')

/**
 * EngineBridge: thin socket client connecting Ion to the standalone
 * ion engine server process.
 *
 * Events emitted:
 *  - 'event' (key, EngineEvent) -- forwarded from engine server
 */
export class EngineBridge extends EventEmitter {
  private conn: Socket | null = null
  private buffer = ''
  private connected = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private requestCallbacks = new Map<string, (result: any) => void>()
  private requestCounter = 0
  private connectPromise: Promise<void> | null = null
  private reconnectDisabled = false
  // Treated as internal to the engine-bridge.* module group (used by
  // engine-bridge-start-session.ts). Not `private` so sibling files in
  // the same module group can read/write the registry without forcing
  // every helper back into this already-cap-bound file.
  activeSessions = new Map<string, { config: EngineConfig; conversationId?: string }>()
  /** Client-side key aliases: oldKey → newKey. Rewrites incoming event keys. */
  private keyAliases = new Map<string, string>()

  constructor() {
    super()
  }

  // ─── Connection lifecycle ───

  async connect(): Promise<void> {
    if (this.connected) return
    // Prevent concurrent connect() calls from creating multiple connections.
    // All callers share the same in-flight connection attempt.
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this._doConnect()
    try {
      await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  private async _doConnect(): Promise<void> {
    // Try connecting to existing server
    try {
      await this._connectSocket()
      return
    } catch {
      // Server not running, start it (unless remote mode)
    }

    // In remote mode we never auto-start — just retry.
    if (IS_REMOTE) {
      throw new Error(`Remote engine at ${REMOTE_SOCKET} is not reachable`)
    }

    await this._startServer()

    // Retry connection with backoff — engine may need a moment after install
    const delays = [500, 1000, 2000, 4000]
    for (let i = 0; i < delays.length; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, delays[i]))
      try {
        await this._connectSocket()
        return
      } catch {
        if (i < delays.length - 1) {
          log(`Engine not ready after ${delays[i]}ms, retrying...`)
        }
      }
    }
    throw new Error('Failed to connect to engine after startup')
  }

  private _connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      let conn: Socket
      if (IS_REMOTE) {
        const [host, portStr] = REMOTE_SOCKET.split(':')
        const port = parseInt(portStr, 10)
        conn = createConnection({ host, port })
      } else {
        conn = createConnection(SOCKET_PATH)
      }

      conn.on('connect', () => {
        const wasReconnect = this.reconnectAttempts > 0
        this.conn = conn
        this.connected = true
        this.reconnectAttempts = 0
        this.buffer = ''
        log('Connected to engine server')
        resolve()
        if (wasReconnect) {
          this.emit('reconnected')
          this._reRegisterSessions()
        }
      })

      conn.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString()
        let nl: number
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, nl)
          this.buffer = this.buffer.slice(nl + 1)
          if (!line.trim()) continue
          this._handleMessage(line)
        }
      })

      conn.on('close', () => {
        this.connected = false
        this.conn = null
        log('Disconnected from engine server')
        this._scheduleReconnect()
      })

      conn.on('error', (err: NodeJS.ErrnoException) => {
        if (!this.connected) {
          warn(`connect err: ${err.code} (${REMOTE_SOCKET})`)
          reject(err)
          return
        }
        // For remote connections, emit a toast-friendly event for transient
        // network errors instead of flooding each chat with error bubbles.
        if (IS_REMOTE && (err.code === 'EHOSTDOWN' || err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET')) {
          warn(`Remote engine unreachable (${err.code}) — will reconnect`)
          this._failPendingRequests('Remote engine unreachable')
        } else {
          log(`Connection error: ${err.message}`)
        }
        this.connected = false
        this.conn = null
        this._scheduleReconnect()
      })
    })
  }

  private async _startServer(): Promise<void> {
    // Binary discovery + child-spawn logic lives in engine-bridge-spawn.ts
    // so this file stays under the 600-line cap. The split is purely
    // mechanical; nothing about the contract changes.
    spawnEngineServer(SOCKET_PATH, PID_PATH)
  }

  private _scheduleReconnect(): void {
    if (this.reconnectDisabled) return
    if (this.reconnectTimer) return
    if (this.connected) return
    this.reconnectAttempts++
    const delay = Math.min(500 * Math.pow(2, this.reconnectAttempts - 1), IS_REMOTE ? 8000 : 30000)
    log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this.connected) return
      try {
        await this.connect()
      } catch {
        this._scheduleReconnect()
      }
    }, delay)
  }

  /** Reject all pending request callbacks with an error message. */
  private _failPendingRequests(reason: string): void {
    for (const [id, cb] of this.requestCallbacks) {
      cb({ ok: false, error: reason })
    }
    this.requestCallbacks.clear()
  }

  /** Re-register all tracked sessions on a reconnected engine. */
  private _reRegisterSessions(): void {
    for (const [key, entry] of this.activeSessions) {
      log(`Re-registering session after reconnect: key=${key}`)
      const config = { ...entry.config }
      if (entry.conversationId) {
        config.sessionId = entry.conversationId
      }
      this._sendWithResult({ cmd: 'start_session', key, config }).catch(() => {
        warn(`Failed to re-register session ${key}`)
      })
    }
  }

  /**
   * Remap a session key client-side.
   * Moves the activeSessions entry from oldKey to newKey and registers an alias
   * so incoming engine events keyed by oldKey are transparently rewritten.
   */
  remapSession(oldKey: string, newKey: string): void {
    log(`remapSession: ${oldKey} -> ${newKey}`)
    const entry = this.activeSessions.get(oldKey)
    if (entry) {
      this.activeSessions.set(newKey, entry)
      this.activeSessions.delete(oldKey)
      log(`remapSession: activeSessions entry moved: ${oldKey} -> ${newKey}`)
    } else {
      log(`remapSession: no activeSessions entry for ${oldKey} (session may not have started yet)`)
    }
    this.keyAliases.set(oldKey, newKey)
    // Remove any prior alias that pointed to oldKey to avoid stale chains
    for (const [k, v] of this.keyAliases) {
      if (v === oldKey && k !== oldKey) {
        this.keyAliases.set(k, newKey)
        log(`remapSession: updated transitive alias ${k} -> ${newKey}`)
      }
    }
  }

  private _handleMessage(line: string): void {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      warn(`unparseable message: ${line.substring(0, 200)}`)
      return
    }

    // Command result with requestId -- resolve pending callback
    if (msg.cmd === 'result' && msg.requestId) {
      debug(`result: requestId=${msg.requestId} ok=${msg.ok} err=${msg.error ?? 'none'}`)
      const cb = this.requestCallbacks.get(msg.requestId)
      if (cb) {
        this.requestCallbacks.delete(msg.requestId)
        cb(msg)
      }
      return
    }

    // Session list response
    if (msg.cmd === 'session_list') {
      return
    }

    // Session event -- forward to IPC layer
    if (msg.key && msg.event) {
      // Rewrite key if it has been remapped (client-side alias)
      const routedKey = this.keyAliases.get(msg.key) ?? msg.key
      debug(`event: key=${msg.key}${routedKey !== msg.key ? ` (aliased->${routedKey})` : ''} type=${msg.event.type}`)
      this.emit('event', routedKey, msg.event as EngineEvent)
    }
  }

  // ─── Command helpers ───

  private _send(msg: any): void {
    if (!this.conn || this.conn.destroyed) {
      warn(`_send: dropped message (no connection): cmd=${msg?.cmd} key=${msg?.key}`)
      return
    }
    try {
      this.conn.write(JSON.stringify(msg) + '\n')
    } catch (err: any) {
      error(`_send: write failed: cmd=${msg?.cmd} key=${msg?.key} err=${err.message}`)
    }
  }

  /**
   * Internal command dispatch with typed { ok, error } response.
   *
   * Marked with a leading underscore to signal "treat as internal to the
   * engine-bridge.* module group" — TypeScript's `private` keyword would
   * be stricter but would also prevent sibling files like
   * engine-bridge-start-session.ts from calling it, which is the
   * extraction-driven seam we need to stay under the file-size cap.
   * Treat external callers as a code-review concern, not a compile-time
   * one.
   */
  _sendWithResult(msg: any): Promise<{ ok: boolean; error?: string }> {
    const requestId = `bridge-${++this.requestCounter}-${Date.now()}`
    msg.requestId = requestId

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        warn(`request timed out: requestId=${requestId} cmd=${msg.cmd}`)
        this.requestCallbacks.delete(requestId)
        resolve({ ok: false, error: 'Request timed out' })
      }, 30000)

      this.requestCallbacks.set(requestId, (result) => {
        clearTimeout(timer)
        resolve({ ok: result.ok, error: result.error })
      })

      this._send(msg)
    })
  }

  // Internal to the engine-bridge.* module group. See _sendWithResult
  // for the rationale on widening from `private` to module-package scope.
  _sendWithData<T>(msg: any): Promise<{ ok: boolean; error?: string; data?: T }> {
    const requestId = `bridge-${++this.requestCounter}-${Date.now()}`
    msg.requestId = requestId

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.requestCallbacks.delete(requestId)
        resolve({ ok: false, error: 'Request timed out' })
      }, 30000)

      this.requestCallbacks.set(requestId, (result) => {
        clearTimeout(timer)
        resolve({ ok: result.ok, error: result.error, data: result.data })
      })

      this._send(msg)
    })
  }

  // ─── Public API ───

  async startSession(key: string, config: EngineConfig): Promise<{ ok: boolean; error?: string }> {
    return startSessionImpl(this, key, config)
  }

  /** Send a typed-response command. Sibling helpers (e.g. engine-bridge-fs.ts) layer on top of the bridge via this. */
  async request<T>(cmd: string, payload: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string; data?: T }> {
    await this.connect()
    return this._sendWithData<T>({ cmd, ...payload })
  }

  /** Track the conversation ID for a session so it can be restored on reconnect. */
  updateSessionConversationId(key: string, conversationId: string): void {
    const entry = this.activeSessions.get(key)
    if (entry) {
      entry.conversationId = conversationId
    }
  }

  async sendPrompt(key: string, text: string, model?: string, appendSystemPrompt?: string, imageAttachments?: ImageAttachmentPayload[], implementationPhase?: boolean, enterPlanModeDescription?: string, planModeSparseReminder?: string, planFilePath?: string): Promise<{ ok: boolean; error?: string }> {
    const attCount = imageAttachments?.length ?? 0
    const descLen = enterPlanModeDescription?.length ?? 0
    const reminderLen = planModeSparseReminder?.length ?? 0
    log(`sendPrompt: key=${key} len=${text.length} model=${model ?? 'default'} hasSysPrompt=${!!appendSystemPrompt} images=${attCount} implementationPhase=${implementationPhase ?? false} enterPlanModeDescLen=${descLen} planModeSparseReminderLen=${reminderLen} planFilePath=${planFilePath ?? 'none'}`)
    await this.connect()
    const msg: Record<string, unknown> = { cmd: 'send_prompt', key, text }
    if (model) msg.model = model
    if (appendSystemPrompt) msg.appendSystemPrompt = appendSystemPrompt
    if (imageAttachments && imageAttachments.length > 0) {
      msg.attachments = imageAttachments.map((a) => ({
        media_type: a.mediaType,
        data: a.data,
        path: a.path,
      }))
    }
    // Tells the engine to suppress EnterPlanMode injection for this run.
    // Only sent when truthy so the wire format stays minimal for the
    // common case. The engine's ClientCommand.ImplementationPhase field
    // is omitempty, so this round-trips cleanly. See ADR-003 framing in
    // the plan-mode docs for why structured flags beat prompt prose.
    if (implementationPhase) msg.implementationPhase = true
    // Harness-supplied EnterPlanMode tool description (ADR-004). The
    // engine's RunOptions.EnterPlanModeDescription field is omitempty —
    // only send when non-empty so the wire format stays minimal. The
    // engine forwards the string verbatim to the model as the tool
    // description; empty / missing falls back to the engine's one-line
    // neutral default (which the desktop deliberately avoids by always
    // sending its full prose on auto-mode prompts).
    if (enterPlanModeDescription) msg.enterPlanModeDescription = enterPlanModeDescription
    // Harness-supplied sparse plan-mode reminder text. Only sent when
    // non-empty so the wire format stays minimal for the common case.
    // Mirrors enterPlanModeDescription: the engine uses this verbatim
    // instead of buildPlanModeSparseReminder when present.
    if (planModeSparseReminder) msg.planModeSparseReminder = planModeSparseReminder
    if (planFilePath) msg.planFilePath = planFilePath
    return this._sendWithResult(msg)
  }

  sendAbort(key: string): void {
    const alive = !!(this.conn && !this.conn.destroyed)
    log(`sendAbort: key=${key} connected=${this.connected} connAlive=${alive}`)
    if (!alive) {
      // Socket is gone. Best-effort: schedule a reconnect so subsequent
      // commands have a chance to land. Renderer-side watchdog will recover
      // the stuck tab if no event arrives.
      warn(`sendAbort: socket dead — abort cannot reach engine; renderer watchdog will recover tab=${key}`)
      this._scheduleReconnect()
      return
    }
    this._send({ cmd: 'abort', key })
  }

  sendSteer(key: string, message: string): void {
    log(`sendSteer: key=${key} len=${message.length}`)
    this._send({ cmd: 'steer_agent', key, agentName: '', message })
  }

  sendAbortAgent(key: string, agentName: string, subtree: boolean): void {
    log(`sendAbortAgent: key=${key} agent=${agentName} subtree=${subtree} connected=${this.connected}`)
    this._send({ cmd: 'abort_agent', key, agentName, subtree })
  }

  async sendDialogResponse(key: string, dialogId: string, value: any): Promise<void> {
    debug(`sendDialogResponse: key=${key} dialogId=${dialogId}`)
    this._send({ cmd: 'dialog_response', key, dialogId, value })
  }

  async sendCommand(key: string, command: string, args: string): Promise<void> {
    log(`sendCommand: key=${key} command=${command}`)
    this._send({ cmd: 'command', key, command, args })
  }

  async stopSession(key: string): Promise<void> {
    log(`stopSession: key=${key}`)
    this.activeSessions.delete(key)
    this._send({ cmd: 'stop_session', key })
  }

  sendPermissionResponse(key: string, questionId: string, optionId: string): void {
    log(`sendPermissionResponse: key=${key} questionId=${questionId} optionId=${optionId}`)
    this._send({ cmd: 'permission_response', key, questionId, optionId })
  }

  // Public escape hatch: forwards a fully-shaped ClientCommand to the engine. Companion modules use this to ship additional command/response helpers without growing the bridge file past its cap.
  sendRaw(payload: Record<string, unknown>): void { this._send(payload) }

  sendSetPlanMode(key: string, enabled: boolean, allowedTools?: string[], source?: string): void {
    log(`sendSetPlanMode: key=${key} enabled=${enabled} source=${source ?? 'unknown'}`)
    this._send({ cmd: 'set_plan_mode', key, enabled, allowedTools, source })
  }

  // ─── Conversation-data RPCs ───
  //
  // Bodies live in engine-bridge-conversations.ts. The methods stay on
  // the bridge so external callers (renderer IPC, control plane, OAuth
  // token store) keep their existing surface area. Each wrapper is a
  // single-line delegate — see the sibling file for behavior, logging,
  // and wire-protocol contract notes.

  async listStoredSessions(limit?: number): Promise<any[]> {
    return conv.listStoredSessions(this, limit)
  }

  async loadSessionHistory(sessionId: string): Promise<any[]> {
    return conv.loadSessionHistory(this, sessionId)
  }

  async loadChainHistory(sessionIds: string[]): Promise<any[]> {
    return conv.loadChainHistory(this, sessionIds)
  }

  async getConversation(conversationId: string, offset = 0, limit = 50): Promise<any> {
    return conv.getConversation(this, conversationId, offset, limit)
  }

  async clearConversationFile(conversationId: string): Promise<void> {
    return conv.clearConversationFile(this, conversationId)
  }

  async saveSessionLabel(sessionId: string, label: string): Promise<{ ok: boolean; error?: string }> {
    return conv.saveSessionLabel(this, sessionId, label)
  }

  async generateTitle(text: string): Promise<string> {
    return conv.generateTitle(this, text)
  }

  async migrateConversation(
    sessionId: string,
    targetFormat: string,
    targetDir: string,
    sourceDir: string,
  ): Promise<{ ok: boolean; error?: string; data?: { newSessionId: string; outputPath: string; messageCount: number; contentHash: string } }> {
    return conv.migrateConversation(this, sessionId, targetFormat, targetDir, sourceDir)
  }

  async listModels(): Promise<{ models: any[]; providers: any[] }> {
    await this.connect()
    const result = await this._sendWithData<{ models: any[]; providers: any[] }>({ cmd: 'list_models' })
    return result.data || { models: [], providers: [] }
  }

  async storeCredential(provider: string, credential: string): Promise<{ ok: boolean; error?: string }> {
    await this.connect()
    return this._sendWithResult({ cmd: 'store_credential', provider, credential })
  }

  async refreshModels(provider?: string): Promise<{ ok: boolean; error?: string }> {
    await this.connect()
    const msg: Record<string, unknown> = { cmd: 'refresh_models' }
    if (provider) msg.provider = provider
    return this._sendWithResult(msg)
  }

  sendReconcileState(key: string): void {
    log(`sendReconcileState: key=${key}`)
    this._send({ cmd: 'reconcile_state', key })
  }

  stopByPrefix(prefix: string): void {
    for (const key of this.activeSessions.keys()) {
      if (key.startsWith(prefix)) this.activeSessions.delete(key)
    }
    this._send({ cmd: 'stop_by_prefix', prefix })
  }

  async stopAll(): Promise<void> {
    // Don't send shutdown -- just disconnect. Engine server keeps running for other clients.
    if (this.conn && !this.conn.destroyed) {
      this.conn.destroy()
    }
    this.connected = false
    this.conn = null
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /** Send shutdown command to engine server, causing it to exit. */
  shutdown(): void {
    this._send({ cmd: 'shutdown' })
  }

  /** Kill the engine process and wait for socket to disappear. */
  async shutdownAndWait(timeoutMs = 3000): Promise<void> {
    // Prevent auto-reconnect from spawning a new engine
    this.reconnectDisabled = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    // Try graceful shutdown via socket first
    this._send({ cmd: 'shutdown' })

    // Also kill via PID lock file (reliable even if socket is broken)
    const pidLockFile = `${PID_PATH}.lock`
    try {
      if (existsSync(pidLockFile)) {
        const pid = parseInt(readFileSync(pidLockFile, 'utf-8').trim(), 10)
        if (pid > 0) {
          process.kill(pid, 'SIGTERM')
        }
      }
    } catch {}

    // Wait for socket file to disappear (engine removes it on stop)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!existsSync(SOCKET_PATH)) break
      await new Promise(r => setTimeout(r, 50))
    }

    // Disconnect our side
    if (this.conn && !this.conn.destroyed) {
      this.conn.destroy()
    }
    this.connected = false
    this.conn = null
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  isRunning(key: string): boolean {
    // Can't synchronously check -- return true if connected
    return this.connected
  }
}
