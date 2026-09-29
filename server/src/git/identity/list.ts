/**
 * The redacted, client-facing view of a subject's git credentials --
 * shared by the `gitIdentity.list` studio_action
 * (`protocol/git-identity-actions.ts`), the desktop's direct-call
 * equivalent (`desktop/src/main/ipc/git-identity.ts`), and the
 * `desktop_settings_snapshot` projection that gives iOS a read-only view
 * of the LOCAL principal's own identities (`settings-broadcast.ts`,
 * `remote/handlers/tabs-sync.ts`).
 */
import type { GitIdentitySummary } from '@ion/shared/types-git-identity'
import { gitCredentialStore } from './credential-store'
import { currentServerConfig } from '../../config/current'

/** Every credential `subject` has -- operator-managed entries first, then whatever they set for themselves. */
export function listGitIdentitiesFor(subject: string): GitIdentitySummary[] {
  const admin = currentServerConfig()
    .git.credentials.filter((c) => c.subject === subject)
    .map((c): GitIdentitySummary => ({ host: c.host, source: 'admin', kind: c.kind, publicKey: c.publicKey, username: c.username }))
  const own = gitCredentialStore()
    .listFor(subject)
    .map((record): GitIdentitySummary => ({ host: record.host, source: record.source, kind: record.kind, publicKey: record.publicKey, username: record.username }))
  return [...admin, ...own]
}
