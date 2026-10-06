/**
 * The redacted, client-facing view of a subject's git credentials --
 * shared by the `gitIdentity.list` studio_action
 * (`protocol/git-identity-actions.ts`) and the
 * `desktop_settings_snapshot` projection that gives iOS a read-only view
 * of the LOCAL principal's own identities (`settings-broadcast.ts`,
 * `remote/handlers/tabs-sync.ts`).
 */
import type { GitIdentitySummary } from '@ion/shared/types-git-identity'
import { gitCredentialStore } from './credential-store'
import { currentServerConfig } from '../../config/current'
import { listHostSshKeys } from './host-keys'
import { listHostCliSignIns } from './host-cli'

/**
 * What the host user's own setup offers git: each `~/.ssh` public key (under
 * the hosts `~/.ssh/config` pins it to, or `*` when ssh offers it
 * everywhere) and each git-host CLI sign-in. Empty when
 * `server.json.git.hostCredentials` is off.
 */
export function listHostGitIdentities(): GitIdentitySummary[] {
  if (!currentServerConfig().git.hostCredentials) return []
  const keys = listHostSshKeys().flatMap((key) => (key.pinnedHosts.length > 0 ? key.pinnedHosts : ['*'])
    .map((host): GitIdentitySummary => ({ host, source: 'host', kind: 'ssh', publicKey: key.publicKey, file: key.file })))
  const signIns = listHostCliSignIns()
    .map((s): GitIdentitySummary => ({ host: s.host, source: 'host', kind: 'https-token', username: s.account || undefined, tool: s.tool }))
  return [...keys, ...signIns]
}

/** Every credential `subject` has -- operator-managed entries first, then whatever they set for themselves, then what the host's own setup offers. */
export function listGitIdentitiesFor(subject: string): GitIdentitySummary[] {
  const admin = currentServerConfig()
    .git.credentials.filter((c) => c.subject === subject)
    .map((c): GitIdentitySummary => ({ host: c.host, source: 'admin', kind: c.kind, publicKey: c.publicKey, username: c.username }))
  const own = gitCredentialStore()
    .listFor(subject)
    .map((record): GitIdentitySummary => ({ host: record.host, source: record.source, kind: record.kind, publicKey: record.publicKey, username: record.username }))
  return [...admin, ...own, ...listHostGitIdentities()]
}
