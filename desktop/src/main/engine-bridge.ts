import { EventEmitter } from 'events'
import { createConnection, Socket } from 'net'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log as _log, debug as _debug, warn as _warn, error as _error } from './logger'
import { spawnEngineServer } from './engine-bridge-spawn'
import { startSession as startSessionImpl, reRegisterSessions as reRegisterSessionsImpl } from './engine-bridge-start-session'
import { sendReconcileState as sendReconcileStateImpl, sendQuerySessionStatus as sendQuerySessionStatusImpl } from './engine-bridge-state-sync'
import { buildSendPromptMessage, buildSendPromptLogLine } from './engine-bridge-prompts'
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
  private _drainScheduled = false
  // Package-internal (used by engine-bridge-start-session.ts and other siblings).
  activeSessions = new Map<string, { config: EngineConfig; conversationId?: string }>()
  /** Client-side key aliases: oldKey → newKey. Rewrites incoming event keys. */
  private keyAliases = new Map<string, string>()
  /** Tracks last `engine_status` receipt per key for stale-sweep polling. */
  lastEngineStatusAt = new Map<string, number>()

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
        this._drainBuffer()
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

  /**
   * Process up to BATCH_SIZE messages then yield via setImmediate.
   * Prevents the main process from blocking for 5+ seconds when a large
   * burst of events arrives in one TCP chunk, which triggers the engine's
   * 5s write-deadline eviction → disconnect/reconnect storm.
   */
  private _drainBuffer(): void {
    if (this._drainScheduled) return
    const BATCH_SIZE = 10
    let processed = 0
    let nl: number
    while (processed < BATCH_SIZE && (nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (line.trim()) {
        this._handleMessage(line)
        processed++
      }
    }
    if (this.buffer.indexOf('\n') !== -1) {
      this._drainScheduled = true
      setImmediate(() => {
        this._drainScheduled = false
        this._drainBuffer()
      })
    }
  }

  /** Re-register all tracked sessions, then reconcile (see engine-bridge-start-session.ts). */
  private _reRegisterSessions(): void {
    reRegisterSessionsImpl(this)
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
      // Phase 2 of the state-management overhaul: track the last
      // engine_status receipt per key so the snapshot poller can
      // detect stale keys and issue a query_session_status. We track
      // only engine_status (not every event) because the convergence
      // problem the poller addresses is specifically "we never saw a
      // fresh status event" — text deltas, tool calls, agent state
      // updates do not refresh the running/idle determination.
      if (msg.event.type === 'engine_status') {
        this.lastEngineStatusAt.set(routedKey, Date.now())
      }
      debug(`event: key=${msg.key}${routedKey !== msg.key ? ` (aliased->${routedKey})` : ''} type=${msg.event.type}`)
      this.emit('event', routedKey, msg.event as EngineEvent)
    }
  }

  // ─── Command helpers ───

  // Used by sibling files in the engine-bridge.* module group (see
  // engine-bridge-state-sync.ts). Not `private` so the state-sync RPCs
  // can dispatch without forcing every helper back into this already-
  // cap-bound file. Same convention as _sendWithResult / _sendWithData.
  _send(msg: any): void {
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

  /**
   * Return a shallow copy of the last EngineConfig used to start this session
   * key, or undefined if the key was never started. Used by the divergence
   * resume path (engine-control-plane-events.ts) so a post-restart resume
   * carries the tab's real workingDirectory/extensions/model instead of empty
   * placeholders. Returning a copy keeps callers from mutating bridge state.
   */
  getSessionConfig(key: string): EngineConfig | undefined {
    const entry = this.activeSessions.get(key)
    return entry ? { ...entry.config } : undefined
  }

  async sendPrompt(key: string, text: string, model?: string, appendSystemPrompt?: string, imageAttachments?: ImageAttachmentPayload[], implementationPhase?: boolean, enterPlanModeDescription?: string, planModeSparseReminder?: string, planFilePath?: string, bashAllowlistAdditionsForThisPrompt?: string[]): Promise<{ ok: boolean; error?: string }> {
    // Message construction and the diagnostic log line live in
    // engine-bridge-prompts.ts so this file stays under the 600-line cap
    // as the send_prompt wire surface grows. See that sibling for the
    // per-field omitempty pattern and the bash-additions log convention.
    const args = { key, text, model, appendSystemPrompt, imageAttachments, implementationPhase, enterPlanModeDescription, planModeSparseReminder, planFilePath, bashAllowlistAdditionsForThisPrompt }
    log(buildSendPromptLogLine(args))
    await this.connect()
    return this._sendWithResult(buildSendPromptMessage(args))
  }

  sendAbort(key: string): void {
    const alive = !!(this.conn && !this.conn.destroyed)
    log(`sendAbort: key=${key} connected=${this.connected} connAlive=${alive}`)
    if (!alive) {
      warn(`sendAbort: socket dead — scheduling reconnect; renderer watchdog will recover tab=${key}`)
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

  sendRaw(payload: Record<string, unknown>): void { this._send(payload) }

  sendSetPlanMode(key: string, enabled: boolean, allowedTools?: string[], source?: string, allowedBashCommands?: string[]): void {
    log(`sendSetPlanMode: key=${key} enabled=${enabled} source=${source ?? 'unknown'} bashCmds=${JSON.stringify(allowedBashCommands)}`)
    this._send({ cmd: 'set_plan_mode', key, enabled, allowedTools, source, planModeAllowedBashCommands: allowedBashCommands })
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

  sendReconcileState(key: string): void { sendReconcileStateImpl(this, key) }
  sendQuerySessionStatus(key: string): void { sendQuerySessionStatusImpl(this, key) }

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
