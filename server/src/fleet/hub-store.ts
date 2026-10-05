/**
 * The hubs an admin of this server added, and the credential each hub
 * issued this server, in `<data dir>/fleet-hubs.json`. Tokens and
 * credentials are sealed with the server's secret store. A hub the
 * enterprise policy names is not listed here; only its credential is kept.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { decryptFromDisk, encryptForDisk } from '../utils/secretStore'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('fleet.hub-store', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('fleet.hub-store', msg, fields)
}

/** A hub an admin of this server added. */
export interface AddedHub {
  /** Normalized (`normalizeHubUrl`). */
  url: string
  manage: boolean
  enrollmentToken: string
  /** The name the server reports to this hub under; absent means its own label. */
  label?: string
}

interface HubsFile {
  version: 1
  /** Sealed enrollment tokens of added hubs. */
  added: Array<{ url: string; manage: boolean; enrollmentTokenRef: string; label?: string }>
  /** Sealed credentials, by hub URL, for added and policy hubs alike. */
  credentials: Record<string, string>
}

const FILE = 'fleet-hubs.json'

function empty(): HubsFile {
  return { version: 1, added: [], credentials: {} }
}

export class FleetHubStore {
  constructor(private readonly dir: string) {}

  private read(): HubsFile {
    const path = join(this.dir, FILE)
    if (!existsSync(path)) return empty()
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<HubsFile>
      return {
        version: 1,
        added: Array.isArray(raw.added) ? raw.added.filter((h) => typeof h?.url === 'string' && typeof h.enrollmentTokenRef === 'string') : [],
        credentials: raw.credentials && typeof raw.credentials === 'object' ? raw.credentials : {},
      }
    } catch (err) {
      warn('fleet-hubs.json unreadable; treating as empty', { error: String(err) })
      return empty()
    }
  }

  private write(file: HubsFile): void {
    atomicWriteFileSync(join(this.dir, FILE), JSON.stringify(file, null, 2) + '\n', 0o600)
  }

  added(): AddedHub[] {
    return this.read().added.map((h) => ({ url: h.url, manage: h.manage !== false, enrollmentToken: decryptFromDisk(h.enrollmentTokenRef), label: typeof h.label === 'string' && h.label ? h.label : undefined }))
  }

  /** Adds a hub, or replaces the token and manage flag of one already added. A new token means a new enrollment, so the old credential goes. */
  add(hub: AddedHub): void {
    const file = this.read()
    const replaced = file.added.some((h) => h.url === hub.url)
    file.added = [...file.added.filter((h) => h.url !== hub.url), { url: hub.url, manage: hub.manage, enrollmentTokenRef: encryptForDisk(hub.enrollmentToken), ...(hub.label ? { label: hub.label } : {}) }]
    delete file.credentials[hub.url]
    this.write(file)
    log('hub saved', { hub_url: hub.url, manage: hub.manage, replaced })
  }

  /** False when no such hub was added. */
  remove(url: string): boolean {
    const file = this.read()
    const had = file.added.some((h) => h.url === url)
    if (!had) return false
    file.added = file.added.filter((h) => h.url !== url)
    delete file.credentials[url]
    this.write(file)
    log('hub removed', { hub_url: url })
    return true
  }

  credential(url: string): string | null {
    const ref = this.read().credentials[url]
    return ref ? decryptFromDisk(ref) : null
  }

  setCredential(url: string, credential: string): void {
    const file = this.read()
    file.credentials[url] = encryptForDisk(credential)
    this.write(file)
    log('hub credential saved', { hub_url: url })
  }

  clearCredential(url: string): void {
    const file = this.read()
    if (!(url in file.credentials)) return
    delete file.credentials[url]
    this.write(file)
    log('hub credential cleared', { hub_url: url })
  }
}
