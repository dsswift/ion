/**
 * The file-backed `SubscriptionCache`: one encrypted record per person and
 * provider in `<ION_DATA_DIR>/subscription-lookup.json`.
 *
 * The key is a secret, so the record is encrypted with the same tier-2 store
 * the browser session tokens use (`utils/secretStore.ts`). Only the key is
 * encrypted separately from the labels, so a listing never decrypts anything.
 * A person's entry is addressed by their subject, so one person's key is
 * never read for another.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { dataDir } from '../paths'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { decryptFromDisk, encryptForDisk } from '../utils/secretStore'
import type { SubscriptionOption } from '@ion/shared/types-engine-event'
import type { CachedSubscription, SubscriptionCache } from './subscription-state'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('subscription-cache', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('subscription-cache', msg, fields)
}

interface StoredEntry {
  subject: string
  provider: string
  selectedId: string
  label: string
  /** Tier-2 ciphertext of the key. */
  keyRef: string
  options: SubscriptionOption[]
  resolvedAt: number
}

interface CacheFile {
  version: 1
  entries: StoredEntry[]
}

const FILENAME = 'subscription-lookup.json'

export class FileSubscriptionCache implements SubscriptionCache {
  constructor(private readonly dir: () => string = dataDir) {}

  private path(): string {
    return join(this.dir(), FILENAME)
  }

  private read(): CacheFile {
    const path = this.path()
    if (!existsSync(path)) return { version: 1, entries: [] }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as CacheFile).entries)) {
        throw new Error('root is not a { version, entries[] } object')
      }
      return parsed as CacheFile
    } catch (err) {
      warn('subscription-lookup.json unreadable; starting empty', { error: String(err) })
      return { version: 1, entries: [] }
    }
  }

  load(subject: string, provider: string): CachedSubscription | null {
    const entry = this.read().entries.find((e) => e.subject === subject && e.provider === provider)
    if (!entry) return null
    try {
      return { selectedId: entry.selectedId, label: entry.label, key: decryptFromDisk(entry.keyRef), options: entry.options, resolvedAt: entry.resolvedAt }
    } catch (err) {
      warn('cached subscription key could not be decrypted; ignoring it', { subject, provider, error: String(err) })
      return null
    }
  }

  save(subject: string, provider: string, entry: CachedSubscription): void {
    const file = this.read()
    const stored: StoredEntry = {
      subject,
      provider,
      selectedId: entry.selectedId,
      label: entry.label,
      keyRef: encryptForDisk(entry.key),
      options: entry.options,
      resolvedAt: entry.resolvedAt,
    }
    file.entries = [...file.entries.filter((e) => !(e.subject === subject && e.provider === provider)), stored]
    atomicWriteFileSync(this.path(), JSON.stringify(file, null, 2), 0o600)
    log('subscription cache written', { subject, provider, subscription_id: entry.selectedId })
  }

  clear(subject: string, provider: string): void {
    const file = this.read()
    const next = file.entries.filter((e) => !(e.subject === subject && e.provider === provider))
    if (next.length === file.entries.length) return
    file.entries = next
    atomicWriteFileSync(this.path(), JSON.stringify(file, null, 2), 0o600)
    log('subscription cache cleared', { subject, provider })
  }
}
