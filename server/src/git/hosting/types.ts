/**
 * Git hosting: what the server needs from a git host beyond git itself --
 * who a token acts as, where that account can create a repository, and
 * creating one. Each host kind is one {@link GitHostingProvider}; `registry.ts`
 * maps a hostname to its provider, so a new kind of host is one new provider
 * file and one registry line.
 */
import type { GitHostingCreateRequest, GitHostingOwner, GitHostingProviderKind, GitHostingRepository } from '@ion/shared/types-git-hosting'
import type { GitCredentialSource } from '../identity/types'

/** The token a provider call presents, and where it came from (a host can want a different header per kind of token). */
export interface GitHostingAuth {
  token: string
  source: GitCredentialSource
}

/** One git host as a provider sees it. */
export interface GitHostingTarget {
  host: string
  /** The API root, without a trailing slash. */
  apiBaseUrl: string
}

export interface GitHostingProvider {
  kind: GitHostingProviderKind
  /** Whether a new repository's visibility is a choice on this host. */
  choosesVisibility: boolean
  /** The API root for `host` when `server.json` names none. */
  defaultApiBaseUrl(host: string): string
  /** The account name the token acts as. */
  account(target: GitHostingTarget, auth: GitHostingAuth): Promise<string>
  /** Everywhere that account can create a repository, its own space first. */
  owners(target: GitHostingTarget, auth: GitHostingAuth): Promise<GitHostingOwner[]>
  /** Creates the repository with one commit holding a README. */
  createRepository(target: GitHostingTarget, auth: GitHostingAuth, request: GitHostingCreateRequest): Promise<GitHostingRepository>
}

/** A git host refused or failed a call. `message` is the host's own words where it gave any. */
export class GitHostingError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'GitHostingError'
  }
}
