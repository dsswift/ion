/**
 * NewRepositoryPanel — Add project's "New repository" source: create a
 * repository on a git host and clone it onto the server this page is about.
 * Any connected server holding a token for the account can do the creating;
 * this server only has to clone the result.
 */
import React, { useState } from 'react'
import { environmentClient } from '../environment/environment-client'
import { useSettingsEnvironment } from '../settings-servers'
import { Button, ErrorText, Field, MonoLine, SidePanel, Stack } from '../kit'
import { useFleetServers } from '../../../studio/new-project/fleet-servers'
import { useHostingAccounts } from '../../../studio/new-project/hosting-accounts'
import { EMPTY_REPOSITORY_DRAFT, createRepositoryFromDraft, draftProblem, type RepositoryDraft } from '../../../studio/new-project/new-repository'
import { NewRepositoryFields } from '../../../studio/new-project/NewRepositoryFields'
import { rInfo, rWarn } from '../../../rendererLogger'

export interface NewRepositoryPanelProps {
  /** Where clones land on this server. */
  baseDir: string
  /** Add project's source switch, drawn above the fields. */
  sourceSwitch: React.ReactNode
  onDone(): void
  onClose(): void
}

export function NewRepositoryPanel({ baseDir, sourceSwitch, onDone, onClose }: NewRepositoryPanelProps): React.JSX.Element {
  const env = useSettingsEnvironment()
  const servers = useFleetServers()
  const hosting = useHostingAccounts(servers.filter((s) => s.online).map((s) => s.id))
  const [draft, setDraft] = useState<RepositoryDraft>(EMPTY_REPOSITORY_DRAFT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const base = baseDir.replace(/\/$/, '')

  const createAndClone = (): void => {
    setBusy(true)
    setError(null)
    void (async () => {
      const repository = await createRepositoryFromDraft(draft, hosting.accounts)
      // The person just made this repository, so its clone is trusted.
      await environmentClient.cloneProject(env.id, { sshUrl: repository.sshUrl, httpsUrl: repository.httpsUrl }, baseDir, repository.name, true)
      rInfo('add-project', 'new repository clone started', { environment_id: env.id, git_host: repository.host })
    })().then(onDone).catch((err: unknown) => {
      rWarn('add-project', 'failed', { environment_id: env.id, source: 'new', error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => setBusy(false))
  }

  return (
    <SidePanel
      open
      title={`Add project to ${env.label}`}
      subtitle="Conversations can start in any project on this server."
      onClose={onClose}
      footer={<Button variant="primary" disabled={busy || draftProblem(draft, hosting.accounts) !== null} onClick={createAndClone}>{busy ? 'Creating…' : 'Create and clone'}</Button>}
    >
      <Stack>
        {sourceSwitch}
        <ErrorText>{error}</ErrorText>
        <NewRepositoryFields accounts={hosting.accounts} problems={hosting.problems} loading={hosting.loading} draft={draft} disabled={busy} onChange={setDraft} serverLabel={(id) => servers.find((s) => s.id === id)?.label ?? id} />
        {hosting.accounts.length > 0 && <Field label="Clones into"><MonoLine>{`${base}/${draft.name.trim() || '<name>'}`}</MonoLine></Field>}
      </Stack>
    </SidePanel>
  )
}
