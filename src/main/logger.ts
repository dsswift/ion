import { appendFile, appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const LOG_FILE = join(homedir(), '.coda-debug.log')
const FLUSH_INTERVAL_MS = 500
const MAX_BUFFER_SIZE = 64

let buffer: string[] = []
let timer: ReturnType<typeof setInterval> | null = null
/** All chunks handed to async appendFile not yet confirmed written */
const inFlight = new Map<number, string>()
let nextChunkId = 1

function flush(): void {
  if (buffer.length === 0) return
  const chunk = buffer.join('')
  buffer = []
  const chunkId = nextChunkId++
  inFlight.set(chunkId, chunk)
  appendFile(LOG_FILE, chunk, () => { inFlight.delete(chunkId) })
}

function ensureTimer(): void {
  if (timer) return
  timer = setInterval(flush, FLUSH_INTERVAL_MS)
  if (timer && typeof timer === 'object' && 'unref' in timer) {
    timer.unref()
  }
}

export function log(tag: string, msg: string): void {
  buffer.push(`[${new Date().toISOString()}] [${tag}] ${msg}\n`)
  if (buffer.length >= MAX_BUFFER_SIZE) flush()
  ensureTimer()
}

/**
 * Synchronously drain all pending logs. Call on shutdown to guarantee
 * every buffered or in-flight line is persisted before the process exits.
 */
export function flushLogs(): void {
  if (timer) { clearInterval(timer); timer = null }
  // Re-write all in-flight chunks synchronously (async writes may not have landed)
  const pendingInflight = Array.from(inFlight.values()).join('')
  const pending = pendingInflight + buffer.join('')
  inFlight.clear()
  buffer = []
  if (pending) {
    try { appendFileSync(LOG_FILE, pending) } catch {}
  }
}

export { LOG_FILE }
