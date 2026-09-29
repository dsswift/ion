/**
 * The `user` git credential source (lowest resolver precedence): whatever a
 * person set for themselves via `gitIdentity.*` actions
 * (`protocol/git-identity-actions.ts`) -- a server-minted SSH keypair
 * (default), a pasted SSH private key, or a pasted HTTPS token. Persisted in
 * `credential-store.ts`, keyed `(subject, host)`.
 */
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { gitCredentialStore, type GitCredentialStore } from '../credential-store'
import type { GitCredentialLookup, GitCredentialSourceProvider } from '../types'
import { log as _log, warn as _warn } from '../../../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('git-identity-user-supplied', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('git-identity-user-supplied', msg, fields)
}

// Lazy, not `promisify(execFileCb)` at module load -- see git-exec.ts's
// gitExec doc comment for why: a desktop test that mocks `child_process`
// wholesale (no reason to know about this module) must not crash the
// moment something transitively imports it.
type PromisifiedExecFile = (file: string, args: readonly string[], options?: { signal?: AbortSignal }) => Promise<{ stdout: string; stderr: string }>
let execFilePromise: PromisifiedExecFile | null = null
function execFile(file: string, args: readonly string[], options?: { signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }> {
  execFilePromise ??= promisify(execFileCb) as unknown as PromisifiedExecFile
  return execFilePromise(file, args, options)
}

/**
 * Mints a fresh ed25519 keypair via the system `ssh-keygen`, stores the
 * private key encrypted, and returns the public key for the caller to copy
 * into the remote host's known-hosts/deploy-key UI. The keypair is generated
 * in a throwaway temp directory that is removed regardless of outcome -- the
 * private key never touches disk unencrypted outside that transient file,
 * and never touches disk at all once `credential-store.ts` has it.
 */
export async function mintSshKeypair(store: GitCredentialStore, subject: string, host: string): Promise<{ publicKey: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-git-keygen-'))
  const keyPath = join(dir, 'id_ed25519')
  try {
    await execFile('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `ion:${subject}`, '-f', keyPath], {
      signal: AbortSignal.timeout(10_000),
    })
    const [privateKey, publicKey] = await Promise.all([
      readFile(keyPath, 'utf-8'),
      readFile(`${keyPath}.pub`, 'utf-8'),
    ])
    store.set({ subject, host, source: 'user', kind: 'ssh', privateKey, publicKey: publicKey.trim() })
    log('ssh keypair minted', { subject, git_host: host })
    return { publicKey: publicKey.trim() }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Stores a pasted SSH private key. Derives and stores the matching public key via `ssh-keygen -y` so it can be displayed without re-parsing the private key later. */
export async function setSshPrivateKey(store: GitCredentialStore, subject: string, host: string, privateKey: string): Promise<{ publicKey: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-git-keygen-'))
  const keyPath = join(dir, 'id_pasted')
  try {
    await writeFile(keyPath, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`)
    await chmod(keyPath, 0o600)
    const { stdout } = await execFile('ssh-keygen', ['-y', '-f', keyPath], { signal: AbortSignal.timeout(10_000) })
    const publicKey = stdout.trim()
    store.set({ subject, host, source: 'user', kind: 'ssh', privateKey, publicKey })
    log('ssh private key stored', { subject, git_host: host })
    return { publicKey }
  } catch (err) {
    warn('pasted ssh key rejected: ssh-keygen could not derive a public key from it', { subject, git_host: host, error: String(err) })
    throw new Error('that does not look like a valid SSH private key')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Stores a pasted HTTPS token (PAT). `username` is the account name git presents alongside it -- provider conventions vary (e.g. GitHub accepts the token as the username with an empty password too, but presenting it as the password with the account name as username is the more broadly compatible shape). */
export function setHttpsToken(store: GitCredentialStore, subject: string, host: string, token: string, username: string): void {
  store.set({ subject, host, source: 'user', kind: 'https-token', token, username })
  log('https token stored', { subject, git_host: host, username })
}

/** Removes the user-supplied credential for `(subject, host)`. A no-op (returns false) if the stored record for that pair came from a different source -- this action only ever removes what a person set for themselves. */
export function removeUserCredential(store: GitCredentialStore, subject: string, host: string): boolean {
  const existing = store.get(subject, host)
  if (!existing || existing.source !== 'user') return false
  return store.remove(subject, host)
}

/** The `user` source for the resolver: lowest precedence, consulted only when neither `admin` nor an `exchange-*` source answered. */
export function userSuppliedSource(store: GitCredentialStore = gitCredentialStore()): GitCredentialSourceProvider {
  return {
    name: 'user',
    resolve: (subject, host): GitCredentialLookup => {
      const record = store.get(subject, host)
      if (!record || record.source !== 'user') return null
      if (record.kind === 'ssh') {
        const privateKey = store.privateKeyFor(subject, host)
        if (!privateKey) return null
        return { source: 'user', kind: 'ssh', host, privateKey, publicKey: record.publicKey }
      }
      const token = store.tokenFor(subject, host)
      if (!token) return null
      return { source: 'user', kind: 'https-token', host, token, username: record.username }
    },
  }
}
