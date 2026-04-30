import { EventEmitter } from 'events'
import { createConnection, Socket } from 'net'
import { spawn, execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log as _log, debug as _debug, warn as _warn, error as _error } from './logger'
import type { EngineConfig, EngineEvent } from '../shared/types'

const TAG = 'EngineBridge'
function log(msg: string): void { _log(TAG, msg) }
function debug(msg: string): void { _debug(TAG, msg) }
function warn(msg: string): void { _warn(TAG, msg) }
function error(msg: string): void { _error(TAG, msg) }

const ION_HOME = join(homedir(), '.ion')
const SOCKET_PATH = join(ION_HOME, 'desktop.sock')
const PID_PATH = join(ION_HOME, 'desktop.pid')

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
  private activeSessions = new Map<string, { config: EngineConfig; conversationId?: string }>()

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
      // Server not running, start it
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
      const conn = createConnection(SOCKET_PATH)

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

      conn.on('error', (err) => {
        if (!this.connected) {
          reject(err)
          return
        }
        log(`Connection error: ${err.message}`)
        this.connected = false
        this.conn = null
        this._scheduleReconnect()
      })
    })
  }

  private async _startServer(): Promise<void> {
    log('Starting engine server...')

    // Find ion engine binary
    const bundled = process.resourcesPath
      ? join(process.resourcesPath, 'engine', 'ion')
      : null
    const candidates = [
      ...(bundled ? [bundled] : []),                              // packaged .app
      join(__dirname, '..', '..', '..', 'engine', 'bin', 'ion'), // dev monorepo
      join(homedir(), '.ion', 'bin', 'ion'),                      // installed CLI
    ]

    let binary: string | null = null
    for (const c of candidates) {
      if (existsSync(c)) {
        binary = c
        break
      }
    }

    if (!binary) {
      // Try finding via which
      try {
        binary = execSync('which ion', { encoding: 'utf-8' }).trim()
      } catch {}
    }

    if (!binary) {
      throw new Error('Cannot find ion executable')
    }

    // Spawn as child of Ion.app — keep parent process group/session intact so
    // macOS TCC attributes file-system access to Ion.app rather than recording
    // a separate identity for the engine binary.
    const isJs = binary.endsWith('.js')
    const cmd = isJs ? 'node' : binary
    const args = isJs ? [binary, 'serve'] : ['serve']

    const child = spawn(cmd, args, {
      stdio: 'ignore',
      env: {
        ...process.env,
        ION_SOCKET_PATH: SOCKET_PATH,
        ION_PID_PATH: PID_PATH,
      },
    })
    log(`Spawned engine server: PID ${child.pid}`)
  }

  private _scheduleReconnect(): void {
    if (this.reconnectDisabled) return
    if (this.reconnectTimer) return
    if (this.connected) return
    this.reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000)
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
      debug(`event: key=${msg.key} type=${msg.event.type}`)
      this.emit('event', msg.key, msg.event as EngineEvent)
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

  private _sendWithResult(msg: any): Promise<{ ok: boolean; error?: string }> {
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

  private _sendWithData<T>(msg: any): Promise<{ ok: boolean; error?: string; data?: T }> {
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
    const entry = this.activeSessions.get(key)
    // If we have a tracked conversationId from a previous session lifecycle,
    // inject it into the config so the engine can resume the conversation.
    if (entry?.conversationId && !config.sessionId) {
      config = { ...config, sessionId: entry.conversationId }
    }
    log(`startSession: key=${key} model=${config.model} sessionId=${config.sessionId ?? 'none'}`)
    this.activeSessions.set(key, { config, conversationId: entry?.conversationId })
    await this.connect()
    return this._sendWithResult({ cmd: 'start_session', key, config })
  }

  /** Track the conversation ID for a session so it can be restored on reconnect. */
  updateSessionConversationId(key: string, conversationId: string): void {
    const entry = this.activeSessions.get(key)
    if (entry) {
      entry.conversationId = conversationId
    }
  }

  async sendPrompt(key: string, text: string, model?: string, appendSystemPrompt?: string): Promise<{ ok: boolean; error?: string }> {
    log(`sendPrompt: key=${key} len=${text.length} model=${model ?? 'default'} hasSysPrompt=${!!appendSystemPrompt}`)
    await this.connect()
    const msg: Record<string, unknown> = { cmd: 'send_prompt', key, text }
    if (model) msg.model = model
    if (appendSystemPrompt) msg.appendSystemPrompt = appendSystemPrompt
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

  sendSetPlanMode(key: string, enabled: boolean, allowedTools?: string[], source?: string): void {
    log(`sendSetPlanMode: key=${key} enabled=${enabled} source=${source ?? 'unknown'}`)
    this._send({ cmd: 'set_plan_mode', key, enabled, allowedTools, source })
  }

  async listStoredSessions(limit?: number): Promise<any[]> {
    await this.connect()
    const result = await this._sendWithData<any[]>({ cmd: 'list_stored_sessions', limit: limit || 50 })
    return result.data || []
  }

  async loadSessionHistory(sessionId: string): Promise<any[]> {
    await this.connect()
    const result = await this._sendWithData<any[]>({ cmd: 'load_session_history', key: sessionId })
    return result.data || []
  }

  async loadChainHistory(sessionIds: string[]): Promise<any[]> {
    await this.connect()
    const result = await this._sendWithData<any[]>({ cmd: 'load_session_history', sessionIds })
    return result.data || []
  }

  async getConversation(conversationId: string, offset = 0, limit = 50): Promise<any> {
    await this.connect()
    const result = await this._sendWithData<any>({ cmd: 'get_conversation', key: conversationId, offset, limit })
    return result.data || { messages: [], total: 0, hasMore: false }
  }

  async saveSessionLabel(sessionId: string, label: string): Promise<{ ok: boolean; error?: string }> {
    await this.connect()
    return this._sendWithResult({ cmd: 'save_session_label', key: sessionId, label })
  }

  async generateTitle(text: string): Promise<string> {
    await this.connect()
    const result = await this._sendWithData<{ title: string }>({ cmd: 'generate_title', text })
    return result.data?.title || ''
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
