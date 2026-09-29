/**
 * FR-04 server-side git identity: shared types for the credential store, the
 * three sources (admin refs, OAuth exchange, user-supplied), the precedence
 * resolver, and materialization onto disk.
 *
 * A "credential" here is what git needs to AUTHENTICATE against a remote
 * host (an SSH key or an HTTPS token) for one `(subject, host)` pair. It is
 * a distinct concept from a "git author identity" (name + email), which
 * FR-04's engine half already resolves from `SessionPrincipal` — the server
 * only supplies the credential half; author identity flows to the engine's
 * `ToolEnv` as `GIT_AUTHOR_*`/`GIT_COMMITTER_*` independently (see
 * `engine-bridge-start-session.ts`).
 */

/** Where a resolved credential came from — surfaced to clients so Settings can show provenance, and used to enforce resolver precedence (admin > exchange > user). */
export type GitCredentialSource = 'admin' | 'exchange-ado' | 'exchange-gitlab' | 'exchange-github' | 'user'

/** The two credential shapes git actually consumes. */
export type GitCredentialKind = 'ssh' | 'https-token'

/**
 * One resolved credential for a `(subject, host)` pair, with secrets already
 * decrypted — never sent to a client as-is (see `redactCredential` in
 * `protocol/git-identity-actions.ts`).
 */
export interface ResolvedGitCredential {
  source: GitCredentialSource
  kind: GitCredentialKind
  host: string
  /** SSH: the OpenSSH-format private key. HTTPS: unused. */
  privateKey?: string
  /** SSH: the corresponding public key, safe to display/copy. */
  publicKey?: string
  /** HTTPS: the bearer/PAT value git presents as the password. */
  token?: string
  /** HTTPS: the username git presents alongside `token` (provider-specific: 'oauth2', 'x-access-token', or the account name). */
  username?: string
}

/** A source's answer for one `(subject, host)` lookup. */
export type GitCredentialLookup = ResolvedGitCredential | null

/** A source the resolver consults, in precedence order (see `resolver.ts`). */
export interface GitCredentialSourceProvider {
  name: GitCredentialSource
  resolve: (subject: string, host: string) => Promise<GitCredentialLookup> | GitCredentialLookup
}
