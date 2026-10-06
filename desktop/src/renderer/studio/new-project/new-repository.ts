/**
 * new-repository — the "new repository" form's value, what is wrong with
 * it, and the one call that creates it on the server holding the token.
 */
import type { GitHostingRepository, GitHostingVisibility } from '@ion/shared/types-git-hosting'
import { repositoryNameProblem } from '@ion/shared/types-git-hosting'
import { environmentClient } from '../../components/settings/environment/environment-client'
import { creatingEnvironment, type HostingAccountChoice, type HostingOwnerChoice } from './hosting-accounts'
import { rInfo } from '../../rendererLogger'

export interface RepositoryDraft {
  /** A `HostingAccountChoice.key`; empty picks the first account. */
  accountKey: string
  /** A `GitHostingOwner.id`; empty picks the account's first owner. */
  ownerId: string
  name: string
  visibility: GitHostingVisibility
  description: string
}

export const EMPTY_REPOSITORY_DRAFT: RepositoryDraft = { accountKey: '', ownerId: '', name: '', visibility: 'private', description: '' }

/** The account and owner a draft names, falling back to the first of each. */
export function draftSelection(draft: RepositoryDraft, accounts: readonly HostingAccountChoice[]): { account: HostingAccountChoice; owner: HostingOwnerChoice } | null {
  const account = accounts.find((a) => a.key === draft.accountKey) ?? accounts[0]
  const owner = account?.owners.find((o) => o.id === draft.ownerId) ?? account?.owners[0]
  return account && owner ? { account, owner } : null
}

/** Why the draft cannot be created yet, or null when it can. An untouched name is not yet a problem to show. */
export function draftProblem(draft: RepositoryDraft, accounts: readonly HostingAccountChoice[]): string | null {
  if (!draftSelection(draft, accounts)) return 'No git host account is available.'
  return repositoryNameProblem(draft.name.trim())
}

/** Creates the repository on the server that holds a token for its owner. */
export async function createRepositoryFromDraft(draft: RepositoryDraft, accounts: readonly HostingAccountChoice[]): Promise<GitHostingRepository> {
  const selection = draftSelection(draft, accounts)
  if (!selection) throw new Error('No git host account is available.')
  const environmentId = creatingEnvironment(selection.owner)
  const description = draft.description.trim()
  rInfo('new-project', 'creating repository', { environment_id: environmentId, git_host: selection.account.host, owner: selection.owner.label, name: draft.name.trim(), visibility: draft.visibility })
  const repository = await environmentClient.createRepository(environmentId, {
    host: selection.account.host,
    owner: selection.owner.id,
    name: draft.name.trim(),
    visibility: draft.visibility,
    ...(description ? { description } : {}),
  })
  rInfo('new-project', 'repository created', { environment_id: environmentId, git_host: repository.host, owner: repository.owner, name: repository.name })
  return repository
}
