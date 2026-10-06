/**
 * CloneToServersPanel — puts a project one server already has onto more of
 * them. The servers that hold the same repository are shown as having it;
 * the rest can be ticked, and each clones from the project's own remote.
 */
import React, { useEffect, useMemo, useState } from 'react'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import { Button, ErrorText, Field, Inline, MonoLine, Muted, Switch } from '../../components/settings/kit'
import { readConversationCatalog } from '../connection/catalog'
import { useProjectsByEnvironment } from '../connection/environment-projects'
import { rError } from '../../rendererLogger'
import { useFleetServers } from './fleet-servers'
import { useFleetClone } from './fleet-clone'
import { FleetTargetPicker } from './FleetTargetPicker'
import { FleetCloneRows } from './FleetCloneRows'
import { ProjectDialog } from './ProjectDialog'

export interface CloneToServersPanelProps {
  /** The server the project is being copied from, and its directory there. */
  environmentId: string
  directory: string
  onClose(): void
}

function folderName(directory: string): string {
  return directory.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
}

export function CloneToServersPanel({ environmentId, directory, onClose }: CloneToServersPanelProps): React.JSX.Element {
  const servers = useFleetServers()
  const [catalog, setCatalog] = useState<EnvironmentCatalogEntry[]>([])
  useEffect(() => {
    void readConversationCatalog().then(setCatalog).catch((err: unknown) => rError('new-project.clone-to-servers', 'catalog read failed', { error: String(err) }))
  }, [])
  const byEnvironment = useProjectsByEnvironment(catalog)
  const run = useFleetClone()
  const [targets, setTargets] = useState<ReadonlySet<string>>(new Set())
  const [trust, setTrust] = useState<boolean | null>(null)

  const source = byEnvironment[environmentId]?.find((p) => p.dir === directory)
  const url = source ? source.entry.cloneUrl ?? source.originUrl : undefined
  const repoRemote = source?.entry.repoRemote
  const holders = useMemo(() => new Set(Object.entries(byEnvironment)
    .filter(([id, projects]) => id === environmentId || (repoRemote !== undefined && projects.some((p) => p.entry.repoRemote === repoRemote)))
    .map(([id]) => id)), [byEnvironment, environmentId, repoRemote])
  const chosen = servers.filter((s) => s.online && targets.has(s.id) && !holders.has(s.id))
  // An absent `trusted` means trusted, as it does in the registry.
  const trusted = trust ?? (source !== undefined && source.trusted !== false)
  const name = source?.displayName ?? folderName(directory)
  const started = run.targets.length > 0

  const footer = started
    ? <Button variant="primary" onClick={onClose}>{run.settled ? 'Done' : 'Hide'}</Button>
    : <>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={!url || chosen.length === 0} onClick={() => run.start({ targets: chosen.map((s) => ({ environmentId: s.id, label: s.label })), source: url!, name: folderName(directory), trust: trusted })}>
        {chosen.length > 1 ? `Clone to ${chosen.length} servers` : 'Clone'}
      </Button>
    </>

  return (
    <ProjectDialog title={`Clone ${name} to servers`} subtitle="Each server clones it into its own clone folder." onClose={onClose} footer={footer}>
      {started ? <FleetCloneRows run={run} /> : <>
        {url ? <Field label="Clones from"><MonoLine>{url}</MonoLine></Field> : source ? <ErrorText>This project has no remote to clone from.</ErrorText> : <Muted>Reading the project…</Muted>}
        <Field label="Clone onto">
          <FleetTargetPicker servers={servers} selected={targets} holders={holders} onChange={setTargets} />
        </Field>
        <Field label="Trust it there" hint="A trusted project runs its setup as soon as the clone lands.">
          <Inline><Switch label="Trust the project on those servers" checked={trusted} onChange={setTrust} /></Inline>
        </Field>
      </>}
    </ProjectDialog>
  )
}
