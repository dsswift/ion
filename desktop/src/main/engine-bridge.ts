import { EventEmitter } from 'events'
import { createConnection, Socket } from 'net'
import { spawn, execSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { log as _log, debug as _debug, warn as _warn, error as _error } from './logger'
import type { EngineConfig, EngineEvent } from '../shared/types'

const TAG = 'EngineBridge'
function log(msg: string): void { _log(TAG, msg) }
function debug(msg: string): void { _debug(TAG, msg) }
function warn(msg: string): void { _warn(TAG, msg) }
function error(msg: string): void { _error(TAG, msg) }

const SOCKET_PATH = join(homedir(), '.ion', 'engine.sock')

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

  constructor() {
    super()
  }

  // ─── Connection lifecycle ───

  async connect(): Promise<void> {
    if (this.connected) return

    // Try connecting to existing server
    try {
      await this._connectSocket()
      return
    } catch {
      // Server not running, start it
    }

    await this._startServer()
    // Retry connection after server starts
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    await this._connectSocket()
  }

  private _connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const conn = createConnection(SOCKET_PATH)

      conn.on('connect', () => {
        this.conn = conn
        this.connected = true
        this.reconnectAttempts = 0
        this.buffer = ''
        log('Connected to engine server')
        resolve()
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
    const candidates = [
      join(__dirname, '..', '..', '..', 'engine', 'bin', 'ion'), // dev monorepo
      join(homedir(), '.ion', 'bin', 'ion'),                      // installed
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

    // Spawn detached so it survives Ion exit
    const isJs = binary.endsWith('.js')
    const cmd = isJs ? 'node' : binary
    const args = isJs ? [binary, 'serve'] : ['serve']

    const child = spawn(cmd, args, {
      stdio: 'ignore',
      detached: true,
    })
    child.unref()
    log(`Spawned engine server: PID ${child.pid}`)
  }

  private _scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000)
    log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        await this._connectSocket()
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
    if (!this.conn || this.conn.destroyed) return
    try {
      this.conn.write(JSON.stringify(msg) + '\n')
    } catch (err: any) {
      log(`Send error: ${err.message}`)
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
    log(`startSession: key=${key} model=${config.model}`)
    await this.connect()
    return this._sendWithResult({ cmd: 'start_session', key, config })
  }

  async sendPrompt(key: string, text: string, model?: string): Promise<{ ok: boolean; error?: string }> {
    log(`sendPrompt: key=${key} len=${text.length} model=${model ?? 'default'}`)
    await this.connect()
    const msg: Record<string, unknown> = { cmd: 'send_prompt', key, text }
    if (model) msg.model = model
    return this._sendWithResult(msg)
  }

  sendAbort(key: string): void {
    log(`sendAbort: key=${key}`)
    this._send({ cmd: 'abort', key })
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
    this._send({ cmd: 'stop_session', key })
  }

  sendPermissionResponse(key: string, questionId: string, optionId: string): void {
    log(`sendPermissionResponse: key=${key} questionId=${questionId} optionId=${optionId}`)
    this._send({ cmd: 'permission_response', key, questionId, optionId })
  }

  sendSetPlanMode(key: string, enabled: boolean, allowedTools?: string[]): void {
    log(`sendSetPlanMode: key=${key} enabled=${enabled}`)
    this._send({ cmd: 'set_plan_mode', key, enabled, allowedTools })
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

  async saveSessionLabel(sessionId: string, label: string): Promise<{ ok: boolean; error?: string }> {
    await this.connect()
    return this._sendWithResult({ cmd: 'save_session_label', key: sessionId, label })
  }

  stopByPrefix(prefix: string): void {
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

  isRunning(key: string): boolean {
    // Can't synchronously check -- return true if connected
    return this.connected
  }
}
