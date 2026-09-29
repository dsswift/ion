/**
 * environment/git-access — can THIS host reach a repository, and who does
 * it commit as. The credential half of "Git access" is the existing
 * per-principal git identity (`gitIdentity.*` actions, FR-04): this module
 * adds the test that proves a stored key or token works, and the host's
 * global author identity that a clone made here will commit with.
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { EnvironmentGitTest, EnvironmentGitAuthor } from '@ion/shared/types-environment-admin'
import { runGit } from '../git/git-runner'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'environment.git-access'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * `git ls-remote --symref <url> HEAD` from a scratch directory, with the
 * principal's credential for the URL's host merged in by `runGit`. Reports
 * the remote's default branch on success and git's own words on failure.
 */
export async function testRemote(url: string): Promise<EnvironmentGitTest> {
  const started = Date.now()
  const scratch = mkdtempSync(join(tmpdir(), 'ion-git-test-'))
  try {
    const out = await runGit(scratch, ['ls-remote', '--symref', url, 'HEAD'])
    const symref = /^ref: refs\/heads\/(\S+)\tHEAD/m.exec(out)
    const result = { url, ok: true, ...(symref ? { defaultBranch: symref[1] } : {}), durationMs: Date.now() - started }
    log('remote reachable', { url, default_branch: result.defaultBranch ?? '', duration_ms: result.durationMs })
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    warn('remote unreachable', { url, error: message })
    return { url, ok: false, error: message, durationMs: Date.now() - started }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function globalConfig(key: string): Promise<string> {
  try {
    return (await runGit(homedir(), ['config', '--global', '--get', key])).trim()
  } catch (err) {
    // An unset key exits 1; that is "empty", not a failure worth surfacing.
    log('global git config key unset', { key, error: String(err) })
    return ''
  }
}

export async function readAuthor(): Promise<EnvironmentGitAuthor> {
  const [name, email] = await Promise.all([globalConfig('user.name'), globalConfig('user.email')])
  log('author read', { has_name: !!name, has_email: !!email })
  return { name, email }
}

export async function writeAuthor(author: EnvironmentGitAuthor): Promise<EnvironmentGitAuthor> {
  const name = author.name.trim()
  const email = author.email.trim()
  if (!name || !email) throw new Error('both a name and an email are required')
  await runGit(homedir(), ['config', '--global', 'user.name', name])
  await runGit(homedir(), ['config', '--global', 'user.email', email])
  log('author written', { name_length: name.length, email_domain: email.split('@')[1] ?? '' })
  return { name, email }
}

/** A public key found in the host user's `~/.ssh`: what git will offer when no Ion credential matches. */
export interface HostSshKey {
  file: string
  type: string
  comment: string
}

/**
 * The public keys in the host's `~/.ssh`. Ion's own git runs with the
 * host's normal ssh when the principal has stored no credential for a
 * remote's host, so these are the keys a clone or push will actually use
 * there; the section shows them so "no Ion credential" does not read as
 * "no access".
 */
export function listHostSshKeys(home: string = homedir()): HostSshKey[] {
  const dir = join(home, '.ssh')
  let names: string[]
  try { names = readdirSync(dir) } catch (err) { log('no ~/.ssh to list', { dir, error: String(err) }); return [] }
  const keys: HostSshKey[] = []
  for (const name of names) {
    if (!name.endsWith('.pub')) continue
    try {
      const [type = '', , ...rest] = readFileSync(join(dir, name), 'utf-8').trim().split(/\s+/)
      keys.push({ file: name, type, comment: rest.join(' ') })
    } catch (err) {
      warn('public key unreadable', { file: name, error: String(err) })
    }
  }
  log('host ssh keys listed', { count: keys.length })
  return keys
}
