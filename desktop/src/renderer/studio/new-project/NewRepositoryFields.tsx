/**
 * NewRepositoryFields — the fields that describe a repository to create:
 * which account, where under it, its name, and who can see it.
 */
import React from 'react'
import type { GitHostingProviderKind, GitHostingVisibility } from '@ion/shared/types-git-hosting'
import { repositoryNameProblem } from '@ion/shared/types-git-hosting'
import { Field, Muted, Segmented, Select, TextInput } from '../../components/settings/kit'
import type { HostingAccountChoice, HostingAccountProblem } from './hosting-accounts'
import { draftSelection, type RepositoryDraft } from './new-repository'

const OWNER_LABEL: Record<GitHostingProviderKind, string> = { github: 'Owner', gitlab: 'Namespace', 'azure-devops': 'Project' }

export interface NewRepositoryFieldsProps {
  accounts: readonly HostingAccountChoice[]
  problems: readonly HostingAccountProblem[]
  loading: boolean
  draft: RepositoryDraft
  disabled?: boolean
  onChange(next: RepositoryDraft): void
  /** Names a server in a problem line. */
  serverLabel(environmentId: string): string
}

export function NewRepositoryFields({ accounts, problems, loading, draft, disabled, onChange, serverLabel }: NewRepositoryFieldsProps): React.JSX.Element {
  const selection = draftSelection(draft, accounts)
  if (loading && accounts.length === 0) return <Muted>Looking for your git host accounts…</Muted>
  if (!selection) {
    return <>
      <Muted>None of your servers is signed in to GitHub, GitLab or Azure DevOps with a token. Add one under Settings, Git access, or sign in with gh, glab or az on a server.</Muted>
      <ProblemLines problems={problems} serverLabel={serverLabel} />
    </>
  }
  const { account, owner } = selection
  const name = draft.name.trim()
  const nameProblem = name ? repositoryNameProblem(name) : null
  return <>
    <Field label="Account">
      <Select aria-label="Git host account" value={account.key} disabled={disabled} onChange={(e) => onChange({ ...draft, accountKey: e.target.value, ownerId: '' })}>
        {accounts.map((a) => <option key={a.key} value={a.key}>{a.account ? `${a.host} · ${a.account}` : a.host}</option>)}
      </Select>
    </Field>
    <Field label={OWNER_LABEL[account.provider]}>
      <Select aria-label="Repository owner" value={owner.id} disabled={disabled} onChange={(e) => onChange({ ...draft, accountKey: account.key, ownerId: e.target.value })}>
        {account.owners.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </Select>
    </Field>
    <Field label="Repository name" hint={nameProblem ?? undefined}>
      <TextInput aria-label="Repository name" mono autoFocus value={draft.name} disabled={disabled} onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder="my-project" spellCheck={false} />
    </Field>
    {account.choosesVisibility && (
      <Field label="Visibility">
        <Segmented<GitHostingVisibility> label="Repository visibility" value={draft.visibility} disabled={disabled} onChange={(visibility) => onChange({ ...draft, visibility })} options={[{ value: 'private', label: 'Private' }, { value: 'public', label: 'Public' }]} />
      </Field>
    )}
    <Field label="Description" hint="Optional.">
      <TextInput aria-label="Repository description" value={draft.description} disabled={disabled} onChange={(e) => onChange({ ...draft, description: e.target.value })} />
    </Field>
    <ProblemLines problems={problems} serverLabel={serverLabel} />
  </>
}

/** A git host that refused a server's token is said, not hidden: it is why an account or owner is missing from the lists. */
function ProblemLines({ problems, serverLabel }: Pick<NewRepositoryFieldsProps, 'problems' | 'serverLabel'>): React.JSX.Element | null {
  const refused = problems.filter((p) => p.host)
  if (refused.length === 0) return null
  return <>{refused.map((p) => <Muted key={`${p.environmentId}|${p.host}`}>{`${p.host} refused ${serverLabel(p.environmentId)}: ${p.error}`}</Muted>)}</>
}
