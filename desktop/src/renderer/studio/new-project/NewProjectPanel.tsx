/**
 * NewProjectPanel — a brand new project in one step: create a repository on
 * a git host, clone it onto the chosen servers at once, and hand the first
 * finished checkout back so a conversation can open in it.
 *
 * The repository starts with one commit, so every clone lands in seconds;
 * the panel waits for all of them, which lets a failed server be seen and
 * retried here and lets the opening server be picked from the ones that
 * finished.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { GitHostingRepository } from '@ion/shared/types-git-hosting'
import { Button, ErrorText, Field, MonoLine, Muted } from '../../components/settings/kit'
import { placeAmong } from '../connection/placement'
import { rInfo, rWarn } from '../../rendererLogger'
import { useFleetServers } from './fleet-servers'
import { useHostingAccounts } from './hosting-accounts'
import { useFleetClone, type FleetCloneRun } from './fleet-clone'
import { EMPTY_REPOSITORY_DRAFT, createRepositoryFromDraft, draftProblem, type RepositoryDraft } from './new-repository'
import { NewRepositoryFields } from './NewRepositoryFields'
import { FleetTargetPicker } from './FleetTargetPicker'
import { FleetCloneRows } from './FleetCloneRows'
import { ProjectDialog } from './ProjectDialog'

/** A checkout a conversation can open in. */
export interface ProjectCheckout {
  environmentId: string
  directory: string
}

export interface NewProjectPanelProps {
  onClose(): void
  /** The new project is cloned; open a conversation in this checkout. */
  onOpenProject(checkout: ProjectCheckout): void
}

/** The finished checkout to open: the one placement scores best, this machine leading so a tie or an unscored fleet keeps it. */
export function checkoutToOpen(run: Pick<FleetCloneRun, 'targets' | 'states'>): ProjectCheckout | null {
  const finished = run.targets.flatMap((target) => {
    const state = run.states[target.environmentId]
    return state?.phase === 'done' ? [{ environmentId: target.environmentId, label: target.label, directory: state.dir }] : []
  }).sort((a, b) => Number(b.environmentId === LOCAL_ENVIRONMENT_ID) - Number(a.environmentId === LOCAL_ENVIRONMENT_ID))
  if (finished.length === 0) return null
  const picked = placeAmong(finished).pick?.id
  const checkout = finished.find((f) => f.environmentId === picked) ?? finished[0]
  return { environmentId: checkout.environmentId, directory: checkout.directory }
}

export function NewProjectPanel({ onClose, onOpenProject }: NewProjectPanelProps): React.JSX.Element {
  const servers = useFleetServers()
  const online = useMemo(() => servers.filter((s) => s.online), [servers])
  const hosting = useHostingAccounts(online.map((s) => s.id))
  const run = useFleetClone()
  const [draft, setDraft] = useState<RepositoryDraft>(EMPTY_REPOSITORY_DRAFT)
  const [targets, setTargets] = useState<ReadonlySet<string>>(new Set([LOCAL_ENVIRONMENT_ID]))
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [repository, setRepository] = useState<GitHostingRepository | null>(null)
  const opened = useRef(false)
  const labelOf = (environmentId: string): string => servers.find((s) => s.id === environmentId)?.label ?? environmentId

  const chosen = online.filter((s) => targets.has(s.id))
  const problem = draftProblem(draft, hosting.accounts)
  const ready = !problem && chosen.length > 0 && !creating

  const create = (): void => {
    setCreating(true)
    setError(null)
    createRepositoryFromDraft(draft, hosting.accounts).then((created) => {
      setRepository(created)
      // The person just made this repository, so its clones are trusted and set up as they land.
      run.start({ targets: chosen.map((s) => ({ environmentId: s.id, label: s.label })), source: { sshUrl: created.sshUrl, httpsUrl: created.httpsUrl }, name: created.name, trust: true })
    }).catch((err: unknown) => {
      rWarn('new-project', 'repository creation failed', { error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => setCreating(false))
  }

  const failed = run.targets.some((t) => run.states[t.environmentId]?.phase === 'failed')
  const checkout = run.settled ? checkoutToOpen(run) : null
  const open = (): void => {
    if (!checkout || opened.current) return
    opened.current = true
    rInfo('new-project', 'opening the new project', { environment_id: checkout.environmentId, directory: checkout.directory, servers: run.targets.length })
    onOpenProject(checkout)
  }
  // Every server finished: nothing is left to decide, so the conversation opens by itself.
  useEffect(() => {
    if (run.settled && !failed) open()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `open` reads the settled run this effect is keyed on
  }, [run.settled, failed])

  if (repository) {
    return (
      <ProjectDialog
        title={`${repository.owner}/${repository.name}`}
        subtitle={run.settled ? (failed ? 'Some servers could not clone it.' : 'Cloned. Opening a conversation…') : 'Created. Cloning onto your servers…'}
        onClose={onClose}
        footer={<>
          <Button onClick={onClose}>{run.settled ? 'Close' : 'Hide'}</Button>
          {run.settled && failed && <Button variant="primary" disabled={!checkout} tooltip={checkout ? undefined : 'No server has a clone to open'} onClick={open}>Open conversation</Button>}
        </>}
      >
        <Field label="Repository"><MonoLine>{repository.webUrl}</MonoLine></Field>
        <FleetCloneRows run={run} />
      </ProjectDialog>
    )
  }

  return (
    <ProjectDialog
      title="New project"
      subtitle="Creates a repository and clones it onto your servers."
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!ready} onClick={create}>{creating ? 'Creating…' : chosen.length > 1 ? `Create and clone to ${chosen.length} servers` : 'Create and clone'}</Button>
      </>}
    >
      <NewRepositoryFields accounts={hosting.accounts} problems={hosting.problems} loading={hosting.loading} draft={draft} disabled={creating} onChange={setDraft} serverLabel={labelOf} />
      {hosting.accounts.length > 0 && (
        <Field label="Clone onto" hint={chosen.length === 0 ? 'Pick at least one server.' : undefined}>
          <FleetTargetPicker servers={servers} selected={targets} disabled={creating} onChange={setTargets} />
        </Field>
      )}
      {hosting.accounts.length > 0 && servers.length === 1 && <Muted>Add more servers under Settings, Servers to clone a project onto several at once.</Muted>}
      <ErrorText>{error}</ErrorText>
    </ProjectDialog>
  )
}
