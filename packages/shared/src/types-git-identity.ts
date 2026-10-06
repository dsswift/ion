// FR-04: per-principal git credentials (Studio Settings "Git identity").
// Shared shape between the server's git.identity.* studio_actions
// (server/src/protocol/git-identity-actions.ts), the desktop main process's
// direct in-process equivalents (main/ipc/git-identity.ts), and every
// renderer that lists/manages them.

/** `host` is the host user's own git access, which Ion reads and never stores: a `~/.ssh` key, or a signed-in git-host CLI. */
export type GitIdentitySource = 'admin' | 'exchange-ado' | 'exchange-gitlab' | 'exchange-github' | 'user' | 'host'
export type GitIdentityKind = 'ssh' | 'https-token'
/** A git-host CLI whose sign-in the server can use. */
export type GitIdentityTool = 'gh' | 'glab' | 'az'

/** One credential a person has for a host, redacted -- never the raw key/token. */
export interface GitIdentitySummary {
  /** The git host, or `*` for a host ssh key that is offered to every host. */
  host: string
  source: GitIdentitySource
  kind: GitIdentityKind
  publicKey?: string
  username?: string
  /** `host` ssh keys only: the public key's file name in `~/.ssh`. */
  file?: string
  /** `host` tokens only: the CLI that is signed in. */
  tool?: GitIdentityTool
}

/** A stable key for one listed credential: a host can carry several `host` rows. */
export function gitIdentityKey(identity: GitIdentitySummary): string {
  return `${identity.source}|${identity.host}|${identity.file ?? identity.tool ?? ''}`
}
