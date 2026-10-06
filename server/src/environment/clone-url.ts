/**
 * Which of a repository's two URLs THIS host should clone by. A repository
 * created through a git host's API comes with an SSH URL and an HTTPS one,
 * and each server in a fleet holds different credentials, so the choice is
 * made here, on the host that will run the clone:
 *
 *  - an SSH key Ion stores for the person and the host: the SSH URL;
 *  - a token Ion stores for them: the HTTPS URL;
 *  - neither, but the host user has ssh keys of their own: the SSH URL;
 *  - nothing at all: the HTTPS URL, which a signed-in CLI's token or an
 *    anonymous read of a public repository can still serve.
 */
import type { GitCloneRemote } from '@ion/shared/types-git-hosting'
import { hostFromUrl } from '../git/identity/remote-host'
import { resolveGitCredential } from '../git/identity/resolver'
import { listHostSshKeys } from '../git/identity/host-keys'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('environment.clone', msg, fields) }

export async function chooseCloneUrl(subject: string | undefined, remote: GitCloneRemote): Promise<string> {
  const sshHost = hostFromUrl(remote.sshUrl)
  const httpsHost = hostFromUrl(remote.httpsUrl)
  const choose = (url: string, reason: string): string => {
    log('clone url chosen', { subject: subject ?? '', transport: url === remote.sshUrl ? 'ssh' : 'https', reason, git_host: (url === remote.sshUrl ? sshHost : httpsHost) ?? '' })
    return url
  }
  if (subject && sshHost && await resolveGitCredential(subject, sshHost, { kind: 'ssh' })) return choose(remote.sshUrl, 'stored ssh key')
  if (subject && httpsHost) {
    const token = await resolveGitCredential(subject, httpsHost, { kind: 'https-token' })
    if (token && token.source !== 'host') return choose(remote.httpsUrl, 'stored token')
  }
  if (listHostSshKeys().length > 0) return choose(remote.sshUrl, 'host ssh keys')
  return choose(remote.httpsUrl, 'no ssh key on this host')
}
