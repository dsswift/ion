/**
 * studio-terminal-persistence — restart persistence for SURFACE terminals
 * (the `studio:` pty namespace).
 *
 * Conversation terminals persist their buffers inside tabs.json
 * (PersistedTab.terminalBuffers); surface terminals belong to no tab, so
 * their scrollback + lifecycle metadata persist here: serialized on quit,
 * restored into `terminalScrollback` + a restored-exit map at boot. A
 * restored terminal attaches with full history and an exited state, and
 * respawns on demand (D2).
 */
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { atomicWriteFileSync } from './utils/atomicWrite'
import { terminalScrollback } from './state'
import { terminalManager } from './terminal-manager-instance'
import { log, warn } from './logger'

const FILE = join(homedir(), '.ion', 'studio-terminals.json')
const STUDIO_PREFIX = 'studio:'

interface PersistedStudioTerminal {
  key: string
  history: string
  exitCode: number | null
  cwd: string
}

interface PersistedFile {
  version: 1
  terminals: PersistedStudioTerminal[]
}

/**
 * Exit codes restored from disk, keyed by terminal key. The manager has no
 * lifecycle record for a restored-but-not-respawned terminal; the attach
 * handler consults this so a restored terminal reports its exited state.
 */
export const restoredStudioExitCodes = new Map<string, number | null>()

/** Serialize every studio-namespace terminal's scrollback + lifecycle. */
export function saveStudioTerminals(): void {
  try {
    const terminals: PersistedStudioTerminal[] = []
    for (const [key, history] of terminalScrollback) {
      if (!key.startsWith(STUDIO_PREFIX)) continue
      const life = terminalManager.getLifecycle(key)
      terminals.push({ key, history, exitCode: life?.exitCode ?? restoredStudioExitCodes.get(key) ?? null, cwd: life?.cwd ?? '~' })
    }
    const payload: PersistedFile = { version: 1, terminals }
    atomicWriteFileSync(FILE, JSON.stringify(payload))
    log('studio_terminals', 'persisted surface terminals', { count: terminals.length })
  } catch (err) {
    warn('studio_terminals', 'persist failed', { error: String(err) })
  }
}

/** Restore persisted studio terminals into the scrollback map at boot. */
export function restoreStudioTerminals(): void {
  try {
    if (!existsSync(FILE)) return
    const raw = JSON.parse(readFileSync(FILE, 'utf-8')) as PersistedFile
    if (raw.version !== 1 || !Array.isArray(raw.terminals)) return
    let count = 0
    for (const t of raw.terminals) {
      if (typeof t.key !== 'string' || !t.key.startsWith(STUDIO_PREFIX)) continue
      if (typeof t.history === 'string' && t.history.length > 0) terminalScrollback.set(t.key, t.history)
      restoredStudioExitCodes.set(t.key, typeof t.exitCode === 'number' ? t.exitCode : null)
      count++
    }
    log('studio_terminals', 'restored surface terminals', { count })
  } catch (err) {
    warn('studio_terminals', 'restore failed', { error: String(err) })
  }
}
