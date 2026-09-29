/**
 * `browser-sessions.json`: the server's registry of server-held browser
 * Studio client sessions (spec 18's server-side successor to the browser
 * doing its own PKCE + in-memory token storage). Same durability model as
 * `credentials-store.ts`'s `credentials.json` -- Tier 2 encryption
 * (`utils/secretStore.ts`) for every token, atomic writes, lives under
 * `dataDir()` (`ION_DATA_DIR`/`/data` in the container) so a pod restart
 * does not force every browser tab to sign in again.
 *
 * A session record's `accessTokenRef`/`refreshTokenRef` hold the Tier-2
 * ciphertext of the raw token strings -- no separate indirection layer,
 * exactly like `credentials.json`'s `secretRef`.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { Scope, StudioPrincipalSummary } from '@ion/shared/studio-wire/types'
import { dataDir } from '../paths'
import { decryptFromDisk, encryptForDisk } from '../utils/secretStore'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('browser-session-store', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('browser-session-store', msg, fields)
}

/** One `browser-sessions.json.sessions[]` entry, on-disk shape. */
export interface BrowserSessionRecord {
  /** Random 32-byte, base64url -- also the `ion_session` cookie value. */
  sessionId: string
  principal: StudioPrincipalSummary
  scopes: Scope[]
  /** Tier-2 ciphertext of the access token. Never logged, never returned decrypted except via `tokensFor`. */
  accessTokenRef: string
  /** Tier-2 ciphertext of the refresh token, or null when the IdP issued none. */
  refreshTokenRef: string | null
  accessExpiresAt: number
  createdAt: number
  lastSeenAt: number
}

interface BrowserSessionsFile {
  version: 1
  sessions: BrowserSessionRecord[]
}

function emptyFile(): BrowserSessionsFile {
  return { version: 1, sessions: [] }
}

function sessionsPath(dir: string): string {
  return join(dir, 'browser-sessions.json')
}

function readFile(dir: string): BrowserSessionsFile {
  const path = sessionsPath(dir)
  if (!existsSync(path)) return emptyFile()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as BrowserSessionsFile).sessions)) {
      throw new Error('browser-sessions.json root is not a { version, sessions[] } object')
    }
    return parsed as BrowserSessionsFile
  } catch (err) {
    warn('browser-sessions.json unreadable or malformed; starting from an empty registry', { error: String(err) })
    return emptyFile()
  }
}

function writeFile(dir: string, file: BrowserSessionsFile): void {
  atomicWriteFileSync(sessionsPath(dir), JSON.stringify(file, null, 2))
}

/** A fresh, URL-safe session id -- also usable directly as the `ion_session` cookie value. */
export function newSessionId(): string {
  return randomBytes(32).toString('base64url')
}

export interface NewSessionInput {
  sessionId: string
  principal: StudioPrincipalSummary
  scopes: Scope[]
  accessToken: string
  refreshToken: string | null
  accessExpiresAt: number
}

export interface SessionTokenUpdate {
  accessToken: string
  refreshToken: string | null
  accessExpiresAt: number
}

/** Decrypted tokens for one session, returned only by `tokensFor`. */
export interface SessionTokens {
  accessToken: string
  refreshToken: string | null
}

export class BrowserSessionStore {
  constructor(private readonly dir: string = dataDir()) {}

  get(sessionId: string): BrowserSessionRecord | undefined {
    return readFile(this.dir).sessions.find((s) => s.sessionId === sessionId)
  }

  /**
   * The freshest (highest `lastSeenAt`) browser session for `subject`, or
   * undefined when none exists. FR-04's ADO on-behalf-of exchange
   * (`git/identity/sources/exchange-ado.ts`) uses this to find a live
   * Entra access token for a subject it only knows by string -- the
   * resolver runs at materialize time, with no live `Connection` (and
   * therefore no `sessionCookie`) in hand. Picking the most recently seen
   * session is the sane choice when a subject has more than one browser
   * tab signed in concurrently.
   */
  mostRecentSessionFor(subject: string): BrowserSessionRecord | undefined {
    const matches = readFile(this.dir).sessions.filter((s) => s.principal.subject === subject)
    if (matches.length === 0) return undefined
    return matches.reduce((freshest, s) => (s.lastSeenAt > freshest.lastSeenAt ? s : freshest))
  }

  create(input: NewSessionInput): BrowserSessionRecord {
    const file = readFile(this.dir)
    const now = Date.now()
    const record: BrowserSessionRecord = {
      sessionId: input.sessionId,
      principal: input.principal,
      scopes: input.scopes,
      accessTokenRef: encryptForDisk(input.accessToken),
      refreshTokenRef: input.refreshToken ? encryptForDisk(input.refreshToken) : null,
      accessExpiresAt: input.accessExpiresAt,
      createdAt: now,
      lastSeenAt: now,
    }
    file.sessions = [...file.sessions.filter((s) => s.sessionId !== input.sessionId), record]
    writeFile(this.dir, file)
    log('session created', { subject: input.principal.subject, scope_count: input.scopes.length })
    return record
  }

  /** Updates `lastSeenAt` on a successful `session` authentication. */
  touch(sessionId: string): void {
    const file = readFile(this.dir)
    const idx = file.sessions.findIndex((s) => s.sessionId === sessionId)
    if (idx < 0) return
    file.sessions[idx] = { ...file.sessions[idx], lastSeenAt: Date.now() }
    writeFile(this.dir, file)
  }

  /** Rotates a session's tokens after a successful refresh. Returns false when no record exists for `sessionId`. */
  updateTokens(sessionId: string, update: SessionTokenUpdate): boolean {
    const file = readFile(this.dir)
    const idx = file.sessions.findIndex((s) => s.sessionId === sessionId)
    if (idx < 0) {
      warn('updateTokens: no such session', { session_id_len: sessionId.length })
      return false
    }
    file.sessions[idx] = {
      ...file.sessions[idx],
      accessTokenRef: encryptForDisk(update.accessToken),
      refreshTokenRef: update.refreshToken ? encryptForDisk(update.refreshToken) : null,
      accessExpiresAt: update.accessExpiresAt,
      lastSeenAt: Date.now(),
    }
    writeFile(this.dir, file)
    log('session tokens rotated', { session_id_len: sessionId.length })
    return true
  }

  /** Deletes a session record. Idempotent -- deleting an already-absent session is not an error. */
  delete(sessionId: string): void {
    const file = readFile(this.dir)
    const next = file.sessions.filter((s) => s.sessionId !== sessionId)
    if (next.length === file.sessions.length) return
    file.sessions = next
    writeFile(this.dir, file)
    log('session deleted', { session_id_len: sessionId.length })
  }

  /** Decrypts and returns the access/refresh tokens for `sessionId`, or null when absent. */
  tokensFor(sessionId: string): SessionTokens | null {
    const record = this.get(sessionId)
    if (!record) return null
    return {
      accessToken: decryptFromDisk(record.accessTokenRef),
      refreshToken: record.refreshTokenRef ? decryptFromDisk(record.refreshTokenRef) : null,
    }
  }
}

let sharedStore: BrowserSessionStore | null = null

/** The process-wide browser session store, lazily bound to `dataDir()` on first use. */
export function browserSessionStore(): BrowserSessionStore {
  if (!sharedStore) sharedStore = new BrowserSessionStore()
  return sharedStore
}

/** TEST ONLY. Reset the process-wide store so tests can point it at a temp dir. */
export function _resetBrowserSessionStoreForTest(dir?: string): void {
  sharedStore = new BrowserSessionStore(dir)
}
