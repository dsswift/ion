import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log as _log, warn as _warn } from '../logger'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import type { AutomationHistoryEntry } from './types'

const TAG = 'automation.history'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export function automationHistoryFile(): string { return join(homedir(), '.ion', 'automation-history.json') }

export class AutomationHistoryStore {
  constructor(private readonly file: string = automationHistoryFile()) {}

  load(): AutomationHistoryEntry[] {
    if (!existsSync(this.file)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { entries?: unknown }
      const raw = Array.isArray(parsed.entries) ? parsed.entries : []
      return raw
        .filter(isHistoryEntry)
        .map((entry) => ({
          ...entry,
          causation: { ...entry.causation, chain: [...entry.causation.chain] },
          ...(entry.trace ? { trace: structuredClone(entry.trace) } : {}),
        }))
    } catch (err) {
      warn('automation history unreadable, starting empty', { path: this.file, error: String(err) })
      return []
    }
  }

  append(entry: AutomationHistoryEntry, limit: number): void {
    if (limit <= 0) return
    const entries = [...this.load(), entry].slice(-limit)
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
      atomicWriteFileSync(this.file, JSON.stringify({ version: 1, entries }, null, 2), 0o600)
      log('automation history saved', { path: this.file, count: entries.length })
    } catch (err) {
      warn('automation history save failed', { path: this.file, error: String(err) })
      throw err
    }
  }
}

function isHistoryEntry(value: unknown): value is AutomationHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<AutomationHistoryEntry>
  return typeof entry.id === 'string' && typeof entry.automationId === 'string'
    && typeof entry.eventType === 'string' && typeof entry.startedAt === 'string'
    && typeof entry.finishedAt === 'string' && !!entry.causation
    && typeof entry.causation.rootId === 'string' && Array.isArray(entry.causation.chain)
    && Number.isInteger(entry.causation.depth) && entry.causation.depth === entry.causation.chain.length
    && (entry.outcome === 'succeeded' || entry.outcome === 'failed' || entry.outcome === 'skipped')
}
