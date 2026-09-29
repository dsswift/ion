/**
 * `secretstore:<key>` reference resolution (manifest C5).
 *
 * `server.json` never carries a literal secret -- every sensitive field (today,
 * only `relays[].psk`) is either a `secretstore:<key>` reference or an empty
 * string. Resolution order per key:
 *
 *   1. `ION_SERVER_<KEY>` env var (key upper-cased, `-` -> `_`) -- the pod/
 *      container path: an operator running the server under an orchestrator
 *      injects the PSK as an env var and never writes it to disk at all.
 *   2. `<dir>/server-secrets.json` -- a small Tier-2-encrypted (see
 *      `utils/secretStore.ts`) key/value file for local/desktop use, where
 *      there is no orchestrator to inject env vars.
 *   3. Unresolved: empty string, logged at WARN (never at ERROR -- an
 *      unconfigured relay is a valid, if inert, configuration).
 *
 * A value that does NOT start with `secretstore:` is returned unchanged --
 * only the reference prefix, never a literal secret, is ever accepted in
 * `server.json` for a field this module is asked to resolve.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { decryptFromDisk, encryptForDisk } from '../utils/secretStore'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('secret-ref', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('secret-ref', msg, fields)
}

const REF_PREFIX = 'secretstore:'
const SECRETS_FILENAME = 'server-secrets.json'

function envKeyFor(key: string): string {
  return `ION_SERVER_${key.toUpperCase().replace(/-/g, '_')}`
}

function secretsPath(dir: string): string {
  return join(dir, SECRETS_FILENAME)
}

function readSecretsFile(dir: string): Record<string, string> {
  const path = secretsPath(dir)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch (err) {
    warn('server-secrets.json unreadable or malformed; treating as empty', { error: String(err) })
    return {}
  }
}

/**
 * Resolves one `server.json` field value. Returns `ref` unchanged when it is
 * not a `secretstore:` reference.
 */
export function resolveSecretRef(ref: string, dir: string): string {
  if (!ref.startsWith(REF_PREFIX)) return ref
  const key = ref.slice(REF_PREFIX.length)
  if (!key) {
    warn('secretstore: reference has an empty key')
    return ''
  }

  const envKey = envKeyFor(key)
  const fromEnv = process.env[envKey]
  if (fromEnv) {
    log('secretstore reference resolved from env var', { key, env_key: envKey })
    return fromEnv
  }

  const stored = readSecretsFile(dir)[key]
  if (typeof stored === 'string' && stored) {
    log('secretstore reference resolved from server-secrets.json', { key })
    return decryptFromDisk(stored)
  }

  warn('secretstore reference could not be resolved from env or server-secrets.json', { key, env_key: envKey })
  return ''
}

/** Writes (encrypted, 0600) one key into `<dir>/server-secrets.json`. Test/admin-tooling use. */
export function writeSecretRef(dir: string, key: string, plaintext: string): void {
  const path = secretsPath(dir)
  const current = readSecretsFile(dir)
  current[key] = encryptForDisk(plaintext)
  atomicWriteFileSync(path, JSON.stringify(current, null, 2))
  log('secretstore key written', { key })
}
