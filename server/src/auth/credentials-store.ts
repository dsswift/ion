/**
 * `credentials.json` (manifest C9): the server's registry of paired clients,
 * encrypted with the Tier 2 store (`utils/secretStore.ts`, the same
 * keyfile-backed AES-256-GCM child 06 moved for the desktop's own secrets).
 *
 * A client record's `secretRef` field holds the client's shared secret
 * itself, at rest encrypted via `encryptForDisk` -- there is no separate
 * indirection layer (no second file a `secretRef` points into). The field is
 * named `secretRef` because that is what manifest C9 names it; the value it
 * carries is the Tier-2 ciphertext of the 32-byte HKDF-derived pairing key
 * (see `remote/pairing.ts`'s DH exchange), the same shape LAN pairing already
 * produces for the desktop<->iOS wire.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Scope } from '@ion/shared/studio-wire/types'
import { dataDir } from '../paths'
import { decryptFromDisk, encryptForDisk } from '../utils/secretStore'
import { decodeSharedSecret } from '../remote/device-secret'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import type { RelayIdentity } from '@ion/shared/studio-wire/relay-envelope'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('credentials-store', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('credentials-store', msg, fields)
}

export type CredentialClientKind = 'desktop' | 'mobile'

/** One `credentials.json.clients[]` entry (manifest C9), on-disk shape. */
export interface CredentialClientRecord {
  clientId: string
  /** Tier-2 ciphertext of the client's base64 shared secret. Never logged, never returned decrypted except via `secretFor`. */
  secretRef: string
  scopes: Scope[]
  subject: string
  createdAt: number
  lastSeen: number
  revokedAt: number | null
  kind: CredentialClientKind
  /** The label the client gave at pairing ("desktop mac", "iPhone"), so a devices list reads as machines rather than hashes. Absent on records from before it was stored. */
  label?: string
  /** The device's stable id, when the client sent one: the same device pairing again replaces this record rather than adding a second. */
  deviceId?: string
  /** Who the device said it is signed in as when it paired; announced on its relay channel (see `remote/relay-oidc-join.ts`). */
  relayIdentity?: RelayIdentity
  /**
   * Where this device receives push notifications, as the device last
   * reported it (`device.registerPush`). The server owns it: every push this
   * server sends the device carries it to the relay, which only delivers.
   */
  push?: PushAddress
}

/** A device's push address: its APNs device token and the APNs environment that issued it. */
export interface PushAddress {
  token: string
  env: 'sandbox' | 'production'
  updatedAt: number
}

interface CredentialsFile {
  version: 1
  clients: CredentialClientRecord[]
}

function emptyFile(): CredentialsFile {
  return { version: 1, clients: [] }
}

function credentialsPath(dir: string): string {
  return join(dir, 'credentials.json')
}

function readFile(dir: string): CredentialsFile {
  const path = credentialsPath(dir)
  if (!existsSync(path)) return emptyFile()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as CredentialsFile).clients)) {
      throw new Error('credentials.json root is not a { version, clients[] } object')
    }
    return parsed as CredentialsFile
  } catch (err) {
    warn('credentials.json unreadable or malformed; starting from an empty registry', { error: String(err) })
    return emptyFile()
  }
}

function writeFile(dir: string, file: CredentialsFile): void {
  atomicWriteFileSync(credentialsPath(dir), JSON.stringify(file, null, 2))
}

export interface NewClientInput {
  clientId: string
  /** The 32-byte shared secret this client will present proofs against. */
  secret: Buffer
  scopes: Scope[]
  subject: string
  kind: CredentialClientKind
  label?: string
  deviceId?: string
  relayIdentity?: RelayIdentity
}

type CredentialsChange = 'added' | 'revoked' | 'rebound'
const changeListeners = new Set<(change: CredentialsChange, clientIds: string[]) => void>()

/**
 * Called after every write that changes WHO is paired: a client added,
 * revoked, or rebound to another subject. `touch` (last seen) is not one. The
 * store stays free of the wire; whoever owns a channel subscribes here.
 */
export function onCredentialsChanged(listener: (change: CredentialsChange, clientIds: string[]) => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function notifyChanged(change: CredentialsChange, clientIds: string[]): void {
  for (const listener of changeListeners) {
    try {
      listener(change, clientIds)
    } catch (err) {
      warn('credentials change listener threw', { change, error: String(err) })
    }
  }
}

export class CredentialsStore {
  constructor(private readonly dir: string = dataDir()) {}

  list(): CredentialClientRecord[] {
    return readFile(this.dir).clients
  }

  get(clientId: string): CredentialClientRecord | undefined {
    return readFile(this.dir).clients.find((c) => c.clientId === clientId)
  }

  /** Registers a new paired client, or replaces an existing record for the same `clientId`. */
  add(input: NewClientInput): CredentialClientRecord {
    const file = readFile(this.dir)
    const now = Date.now()
    const record: CredentialClientRecord = {
      clientId: input.clientId,
      secretRef: encryptForDisk(input.secret.toString('base64')),
      scopes: input.scopes,
      subject: input.subject,
      createdAt: now,
      lastSeen: now,
      revokedAt: null,
      kind: input.kind,
      ...(input.label?.trim() ? { label: input.label.trim() } : {}),
      ...(input.deviceId?.trim() ? { deviceId: input.deviceId.trim() } : {}),
      ...(input.relayIdentity ? { relayIdentity: input.relayIdentity } : {}),
    }
    // The same device pairing again supersedes its earlier record: one
    // desktop is one row in a devices list, however many times it paired.
    const replaced: string[] = []
    if (record.deviceId) {
      for (const c of file.clients) {
        if (c.deviceId === record.deviceId && c.kind === record.kind && c.clientId !== record.clientId && !c.revokedAt) {
          c.revokedAt = now
          replaced.push(c.clientId)
        }
      }
    }
    file.clients = [...file.clients.filter((c) => c.clientId !== input.clientId), record]
    writeFile(this.dir, file)
    log('client registered', { client_id: input.clientId, kind: input.kind, scope_count: input.scopes.length, device_id: record.deviceId ?? '', relay_issuer: record.relayIdentity?.issuer ?? '', replaced })
    notifyChanged('added', [input.clientId, ...replaced])
    return record
  }

  /**
   * Rewrites the subject of every record `matches` accepts to `subject`.
   * Returns the client ids rewritten. Used by the host-identity migration to
   * fold device-shaped subjects into the install's own identity.
   */
  rebindSubjects(matches: (subject: string) => boolean, subject: string): string[] {
    const file = readFile(this.dir)
    const rebound: string[] = []
    for (const c of file.clients) {
      if (c.subject !== subject && matches(c.subject)) {
        c.subject = subject
        rebound.push(c.clientId)
      }
    }
    if (rebound.length > 0) writeFile(this.dir, file)
    log('subjects rebound', { subject, rebound })
    if (rebound.length > 0) notifyChanged('rebound', rebound)
    return rebound
  }

  /** Marks `clientId` revoked. Returns false when no record exists for it. */
  revoke(clientId: string): boolean {
    const file = readFile(this.dir)
    const idx = file.clients.findIndex((c) => c.clientId === clientId)
    if (idx < 0) {
      warn('revoke: no such client', { client_id: clientId })
      return false
    }
    if (file.clients[idx].revokedAt !== null) return true
    file.clients[idx] = { ...file.clients[idx], revokedAt: Date.now() }
    writeFile(this.dir, file)
    log('client revoked', { client_id: clientId })
    notifyChanged('revoked', [clientId])
    return true
  }

  /**
   * Records where `clientId` receives pushes, or clears it with null.
   * Returns false when no live record exists. Not a membership change, so it
   * notifies no listener: nothing about which channels are open depends on it.
   */
  setPushAddress(clientId: string, push: Omit<PushAddress, 'updatedAt'> | null): boolean {
    const file = readFile(this.dir)
    const idx = file.clients.findIndex((c) => c.clientId === clientId && c.revokedAt === null)
    if (idx < 0) {
      warn('setPushAddress: no live client', { client_id: clientId })
      return false
    }
    const { push: _previous, ...rest } = file.clients[idx]
    file.clients[idx] = push ? { ...rest, push: { ...push, updatedAt: Date.now() } } : rest
    writeFile(this.dir, file)
    log(push ? 'push address recorded' : 'push address cleared', { client_id: clientId, apns_env: push?.env ?? '', token_prefix: push?.token.slice(0, 8) ?? '' })
    return true
  }

  /** Updates `lastSeen` on a successful `paired` authentication. */
  touch(clientId: string): void {
    const file = readFile(this.dir)
    const idx = file.clients.findIndex((c) => c.clientId === clientId)
    if (idx < 0) return
    file.clients[idx] = { ...file.clients[idx], lastSeen: Date.now() }
    writeFile(this.dir, file)
  }

  /** Decodes and returns the 32-byte shared secret for `clientId`, or null when absent/undecryptable/wrong-length. */
  secretFor(clientId: string): Buffer | null {
    const record = this.get(clientId)
    if (!record) return null
    const decoded = decodeSharedSecret(decryptFromDisk(record.secretRef))
    if (!decoded.ok) {
      warn('stored client secret could not be decoded', { client_id: clientId, reason: decoded.reason })
      return null
    }
    return decoded.secret
  }
}

let sharedStore: CredentialsStore | null = null

/** The process-wide credentials store, lazily bound to `dataDir()` on first use. */
export function credentialsStore(): CredentialsStore {
  if (!sharedStore) sharedStore = new CredentialsStore()
  return sharedStore
}

/** TEST ONLY. Reset the process-wide store so tests can point it at a temp dir. */
export function _resetCredentialsStoreForTest(dir?: string): void {
  sharedStore = new CredentialsStore(dir)
}
