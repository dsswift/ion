/**
 * Per-environment credential storage for outbound Studio connections (spec
 * 12): a `bearer` refresh/access token, or a `paired` shared secret,
 * encrypted at rest via the SAME `encryptForDisk`/`decryptFromDisk` helpers
 * `@ion/server/utils/secretStore` already uses for `relayApiKey` and
 * `pairedDevices[].sharedSecret` — Tier 1 (Electron safeStorage) when the app
 * is packaged and signed, Tier 2 (keyfile AES-GCM) otherwise. No second
 * encryption scheme: reusing the existing store keeps exactly one
 * implementation of the tier fallback, as `@ion/server`'s own doc comment
 * requires ("Both tiers protect the same fields").
 *
 * Stored at `~/.ion/desktop-connections.json`, main-process only — the
 * renderer never receives a credential (nonfunctional requirement: "paired
 * secrets and bearer tokens live in main only; renderer receives frames
 * without credentials").
 */
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { atomicWriteFileSync } from '@ion/server/utils/atomicWrite'
import { encryptForDisk, decryptFromDisk } from '@ion/server/utils/secretStore'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('connections-credentials', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('connections-credentials', msg, fields)
}

export type CredentialKind = 'bearer' | 'paired'

export interface StoredCredential {
  kind: CredentialKind
  /** Encrypted at rest via encryptForDisk. */
  ref: string
}

type CredentialStore = Record<string, StoredCredential>

let connectionsFilePath = join(homedir(), '.ion', 'desktop-connections.json')

/** TEST ONLY. Redirects the store file so tests never touch the real ~/.ion. */
export function _setConnectionsFilePathForTest(path: string | undefined): void {
  connectionsFilePath = path ?? join(homedir(), '.ion', 'desktop-connections.json')
}

function readStore(): CredentialStore {
  if (!existsSync(connectionsFilePath)) return {}
  try {
    const parsed = JSON.parse(readFileSync(connectionsFilePath, 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as CredentialStore) : {}
  } catch (err) {
    warn('desktop-connections.json unreadable; treating as empty', { error: (err as Error).message })
    return {}
  }
}

function writeStore(store: CredentialStore): void {
  atomicWriteFileSync(connectionsFilePath, JSON.stringify(store, null, 2), 0o600)
}

/** Persists a credential's plaintext for `environmentId`, encrypted at rest. */
export function saveCredential(environmentId: string, kind: CredentialKind, plaintext: string): void {
  const store = readStore()
  store[environmentId] = { kind, ref: encryptForDisk(plaintext) }
  writeStore(store)
  log('credential saved', { environment_id: environmentId, kind })
}

/** Reads back a credential's decrypted plaintext, or null if none is stored. */
export function loadCredential(environmentId: string): { kind: CredentialKind; plaintext: string } | null {
  const record = readStore()[environmentId]
  if (!record) return null
  return { kind: record.kind, plaintext: decryptFromDisk(record.ref) }
}

/** Removes a stored credential (e.g. after a revoke or re-pair). */
export function removeCredential(environmentId: string): void {
  const store = readStore()
  if (!(environmentId in store)) return
  delete store[environmentId]
  writeStore(store)
  log('credential removed', { environment_id: environmentId })
}
