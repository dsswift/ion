import { appendFile, appendFileSync, statSync, renameSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const LOG_FILE = join(homedir(), '.ion', 'desktop.log')
const FLUSH_INTERVAL_MS = 500
const MAX_BUFFER_SIZE = 64
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }

let minLevel: LogLevel = 'INFO'
let buffer: string[] = []
let timer: ReturnType<typeof setInterval> | null = null
let bytesWritten = 0
let bytesInitialized = false

/** All chunks handed to async appendFile not yet confirmed written */
const inFlight = new Map<number, string>()
let nextChunkId = 1

function initBytes(): void {
  if (bytesInitialized) return
  bytesInitialized = true
  try {
    bytesWritten = statSync(LOG_FILE).size
  } catch {
    bytesWritten = 0
  }
}

function rotate(): void {
  const oldPath = LOG_FILE + '.old'
  try { unlinkSync(oldPath) } catch {}
  try { renameSync(LOG_FILE, oldPath) } catch {}
  bytesWritten = 0
}

function flush(): void {
  if (buffer.length === 0) return
  initBytes()
  if (bytesWritten >= MAX_FILE_SIZE) rotate()
  const chunk = buffer.join('')
  buffer = []
  const chunkId = nextChunkId++
  inFlight.set(chunkId, chunk)
  bytesWritten += chunk.length
  appendFile(LOG_FILE, chunk, () => { inFlight.delete(chunkId) })
}

function ensureTimer(): void {
  if (timer) return
  timer = setInterval(flush, FLUSH_INTERVAL_MS)
  if (timer && typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
}

function logAt(level: LogLevel, tag: string, msg: string): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
  buffer.push(`[${new Date().toISOString()}] [${level}] [${tag}] ${msg}\n`)
  if (buffer.length >= MAX_BUFFER_SIZE) flush()
  ensureTimer()
}

/** Set the minimum log level. Messages below this level are discarded. */
export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

/** Backward-compatible log function (INFO level). */
export function log(tag: string, msg: string): void {
  logAt('INFO', tag, msg)
}

export function debug(tag: string, msg: string): void {
  logAt('DEBUG', tag, msg)
}

export function info(tag: string, msg: string): void {
  logAt('INFO', tag, msg)
}

export function warn(tag: string, msg: string): void {
  logAt('WARN', tag, msg)
}

export function error(tag: string, msg: string): void {
  logAt('ERROR', tag, msg)
}

/**
 * Synchronously drain all pending logs. Call on shutdown to guarantee
 * every buffered or in-flight line is persisted before the process exits.
 */
export function flushLogs(): void {
  if (timer) { clearInterval(timer); timer = null }
  initBytes()
  if (bytesWritten >= MAX_FILE_SIZE) rotate()
  const pendingInflight = Array.from(inFlight.values()).join('')
  const pending = pendingInflight + buffer.join('')
  inFlight.clear()
  buffer = []
  if (pending) {
    bytesWritten += pending.length
    try { appendFileSync(LOG_FILE, pending) } catch {}
  }
}

export { LOG_FILE }
