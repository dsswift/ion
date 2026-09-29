// FR-04: per-principal git credentials (Studio Settings "Git identity").
// Shared shape between the server's git.identity.* studio_actions
// (server/src/protocol/git-identity-actions.ts), the desktop main process's
// direct in-process equivalents (main/ipc/git-identity.ts), and every
// renderer that lists/manages them.

export type GitIdentitySource = 'admin' | 'exchange-ado' | 'exchange-gitlab' | 'exchange-github' | 'user'
export type GitIdentityKind = 'ssh' | 'https-token'

/** One credential a person has configured for a host, redacted -- never the raw key/token. */
export interface GitIdentitySummary {
  host: string
  source: GitIdentitySource
  kind: GitIdentityKind
  publicKey?: string
  username?: string
}
