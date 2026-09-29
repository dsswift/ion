/**
 * Writes a resolved git credential to disk as the files git's own mechanisms
 * actually consult, and returns the environment `runGit` merges into its
 * subprocess call. Files live under
 * `<dataDir>/principals/<principalDir(subject)>/git/<host>/` -- inside the
 * subject's own FR-01 partition, which FR-03's execution boundary already
 * keeps unreadable to every other principal's tool calls.
 *
 * SSH: a private key file (mode 0600) plus `GIT_SSH_COMMAND` pointing `ssh`
 * at it with `IdentitiesOnly=yes` (never fall through to the operator's own
 * `~/.ssh/config` identities) and `StrictHostKeyChecking=accept-new` (a
 * server has no interactive prompt to accept a first-connection host key
 * through).
 *
 * HTTPS token: a tiny `GIT_ASKPASS` script (mode 0700) that echoes the
 * username/token git's credential prompt asks for, plus
 * `GIT_TERMINAL_PROMPT=0` so a resolver miss fails fast instead of hanging
 * on an interactive prompt with no terminal attached.
 */
import { mkdir, writeFile, chmod } from 'fs/promises'
import { join } from 'path'
import { dataDir } from '../../paths'
import { principalDir } from '../../conversation/principal-dir'
import type { ResolvedGitCredential } from './types'
import { log as _log } from '../../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('git-identity-materialize', msg, fields)
}

const HOST_SANITIZE = /[^a-zA-Z0-9.-]+/g

function sanitizeHost(host: string): string {
  return host.replace(HOST_SANITIZE, '-')
}

/** `<dataDir>/principals/<principalDir(subject)>/git/<sanitized host>`. */
export function gitMaterializeDir(subject: string, host: string): string {
  return join(dataDir(), 'principals', principalDir(subject), 'git', sanitizeHost(host))
}

/** Writes `cred` to disk for `subject` and returns the additive env `runGit` should merge in. */
export async function materializeGitCredential(subject: string, cred: ResolvedGitCredential): Promise<Record<string, string>> {
  const dir = gitMaterializeDir(subject, cred.host)
  await mkdir(dir, { recursive: true })

  if (cred.kind === 'ssh') {
    const keyPath = join(dir, 'id_key')
    const body = cred.privateKey ?? ''
    await writeFile(keyPath, body.endsWith('\n') ? body : `${body}\n`, { mode: 0o600 })
    await chmod(keyPath, 0o600) // belt-and-suspenders: writeFile's mode is subject to umask, chmod is not
    log('ssh credential materialized', { subject, git_host: cred.host, source: cred.source })
    return {
      GIT_SSH_COMMAND: `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
    }
  }

  const askpassPath = join(dir, 'askpass.sh')
  const username = (cred.username ?? 'oauth2').replace(/'/g, "'\\''")
  const token = (cred.token ?? '').replace(/'/g, "'\\''")
  const script = `#!/bin/sh\ncase "$1" in\n  Username*) printf '%s' '${username}' ;;\n  Password*) printf '%s' '${token}' ;;\nesac\n`
  await writeFile(askpassPath, script, { mode: 0o700 })
  await chmod(askpassPath, 0o700)
  log('https-token credential materialized', { subject, git_host: cred.host, source: cred.source })
  return {
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: '0',
  }
}
