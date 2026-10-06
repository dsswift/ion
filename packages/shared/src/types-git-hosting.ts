// Git hosting: the accounts a server can act as on a git host (GitHub,
// GitLab, Azure DevOps), and the repositories it creates there. Shared
// between the server's `gitHosting.*` studio_actions
// (server/src/git/hosting/actions.ts) and every client that offers "new
// repository".

import type { GitIdentitySource } from './types-git-identity'

export type GitHostingProviderKind = 'github' | 'gitlab' | 'azure-devops'

/** Where a new repository can live: the account itself, or an organization, group, or project it can create in. */
export interface GitHostingOwner {
  /** Opaque to clients: sent back as `GitHostingCreateRequest.owner`. */
  id: string
  label: string
  kind: 'user' | 'org' | 'group' | 'project'
}

/** One git host a server holds a token for, and who that token acts as. */
export interface GitHostingAccount {
  host: string
  provider: GitHostingProviderKind
  /** The account name on the host; empty when the host refused to say. */
  account: string
  /** Which credential the token came from. */
  credentialSource: GitIdentitySource
  owners: GitHostingOwner[]
  /** False where every repository takes its visibility from its owner (an Azure DevOps project). */
  choosesVisibility: boolean
  /** The host's own words when it refused the account or owner listing. */
  error?: string
}

export type GitHostingVisibility = 'private' | 'public'

export interface GitHostingCreateRequest {
  host: string
  /** A `GitHostingOwner.id` from that host's account. */
  owner: string
  name: string
  visibility: GitHostingVisibility
  description?: string
}

/**
 * `gitHosting.startProject`: a new repository, cloned onto the server
 * trusted, opened in a conversation that is sent `prompt`, all as one job.
 */
export interface GitHostingStartProjectRequest extends GitHostingCreateRequest {
  /**
   * The client's id for this project. Asked again while its job runs, the
   * server answers that job; after it failed, a new job resumes at the
   * step that failed.
   */
  requestId: string
  /** The folder the clone lands under; `~` is the server user's home. */
  parentDir: string
  /** The conversation's first prompt; empty opens the conversation without one. */
  prompt: string
  /** The model the conversation starts on; absent keeps the server's default. */
  model?: string
  /** The provider group `model` was picked from, so the pick is never requalified. */
  providerId?: string
  /** The engine profile that hosts the conversation; absent opens a plain one. */
  profileId?: string
}

/** What `gitHosting.startProject` answers: the `create` job to follow, and where the checkout lands. */
export interface GitHostingStartProjectStarted {
  jobId: string
  dir: string
}

/** The two URLs one repository is cloned by; each server picks the one its credentials fit. */
export interface GitCloneRemote {
  sshUrl: string
  httpsUrl: string
}

/** A repository a server just created. It always has one commit, so a worktree can branch from it at once. */
export interface GitHostingRepository extends GitCloneRemote {
  host: string
  provider: GitHostingProviderKind
  /** The owner's path on the host (`org`, `group/subgroup`, `org/project`). */
  owner: string
  name: string
  webUrl: string
  defaultBranch: string
}

/** What a repository name may contain on every supported host. */
export const GIT_REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** Why `name` cannot be a repository name, or null when it can. */
export function repositoryNameProblem(name: string): string | null {
  if (!name) return 'A name is required.'
  if (!GIT_REPOSITORY_NAME.test(name)) return 'Use letters, digits, dots, dashes and underscores, starting with a letter or digit.'
  if (name.endsWith('.git') || name.endsWith('.')) return 'The name cannot end with ".git" or a dot.'
  return null
}
