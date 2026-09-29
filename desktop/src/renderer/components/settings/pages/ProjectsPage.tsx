/**
 * ProjectsPage — the projects registered on the server this page is about:
 * where clones land, one line per project (with any clone or setup still
 * running on its row), and the jobs that have no project yet. A row's
 * verbs live in its `…` menu; clicking it opens the project's detail. On
 * this device the page also carries the default project, profile choice,
 * workspace folders, and the projects enterprise policy manages.
 */
import React, { useMemo, useState } from 'react'
import { ArrowClockwise, ArrowsClockwise, FolderPlus, FolderSimpleDashed, Plus, ShieldCheck, Star, Trash, Wrench, X } from '@phosphor-icons/react'
import type { EnvironmentJob } from '@ion/shared/types-environment-admin'
import { useColors } from '../../../theme'
import { environmentClient, useCloneBaseDir, useEnvironmentJobs, useEnvironmentProjects } from '../environment/environment-client'
import { useSettingsEnvironment } from '../settings-servers'
import { Button, CellText, Chip, DataList, EmptyState, ErrorText, FormGroup, FormRow, MonoLine, Stack, StatusDot, TextInput, type RowMenuItem } from '../kit'
import { AddProjectPanel } from './AddProjectPanel'
import { MoveProjectPanel, ProjectDetailPanel, RemoveProjectPanel } from './ProjectPanels'
import { ManagedProjectsList, useDefaultProject } from './project-local'
import { projectVerbs, setupBlockedReason, useProjectOperations, type RemovalChoice } from './project-operation'
import { buildProjectRows, jobRowName, jobStatus, projectStatus, rowMatches, type ProjectListRow } from './project-rows'
import { rWarn } from '../../../rendererLogger'

type Panel =
  | { kind: 'add' }
  | { kind: 'detail'; dir: string }
  | { kind: 'move'; dir: string }
  | { kind: 'remove'; dir: string; choice: RemovalChoice }

export function ProjectsPage(): React.JSX.Element {
  const env = useSettingsEnvironment()
  const projects = useEnvironmentProjects(env.id)
  const jobs = useEnvironmentJobs(env.id)
  const [baseDir, setBaseDir] = useCloneBaseDir(env.id)
  const [panel, setPanel] = useState<Panel | null>(null)
  const ops = useProjectOperations(env.id, projects.refresh)
  const verbs = projectVerbs(env.id, ops)
  const defaults = useDefaultProject()
  const rows = useMemo(() => buildProjectRows(projects.data ?? [], jobs), [projects.data, jobs])
  const panelProject = panel && panel.kind !== 'add' ? projects.data?.find((p) => p.dir === panel.dir) : undefined
  const runningJob = (dir: string): EnvironmentJob | undefined => jobs.find((j) => j.phase === 'running' && j.dir === dir)
  const appraiseThenConfirm = (dir: string): void => {
    const project = projects.data?.find((p) => p.dir === dir)
    if (project) verbs.appraise(project, (choice) => setPanel({ kind: 'remove', dir, choice }))
  }

  const cancelJob = (job: EnvironmentJob): void => {
    void environmentClient.cancelJob(env.id, job.id).catch((err: unknown) => rWarn('projects-section', 'cancel failed', { error: String(err) }))
  }
  const retryClone = (job: EnvironmentJob): void => {
    void environmentClient.cloneProject(env.id, job.url ?? '', baseDir).catch((err: unknown) => rWarn('projects-section', 'retry failed', { error: String(err) }))
  }

  const rowMenu = (row: ProjectListRow): ReadonlyArray<RowMenuItem | false | null> => {
    if (row.kind === 'job') {
      return row.job.phase === 'running'
        ? [{ label: 'Cancel', icon: X, onSelect: () => cancelJob(row.job) }]
        : [{ label: 'Retry', icon: ArrowClockwise, onSelect: () => retryClone(row.job) }]
    }
    const p = row.project
    const busy = ops.busy(p.dir)
    const blocked = setupBlockedReason(p)
    const isDefault = env.isLocal && defaults.isDefault(p.dir)
    return [
      p.trusted === false && { label: 'Trust project', icon: ShieldCheck, disabled: busy || !p.exists, onSelect: () => verbs.trust(p) },
      { label: 'Run setup', icon: Wrench, disabled: busy || blocked !== null, title: blocked ?? undefined, onSelect: () => verbs.setup(p) },
      { label: 'Fetch from origin', icon: ArrowsClockwise, disabled: busy || !p.isGitRepo || !p.originUrl, onSelect: () => verbs.fetch(p) },
      { label: 'Change location…', icon: FolderSimpleDashed, disabled: busy || !p.exists, onSelect: () => setPanel({ kind: 'move', dir: p.dir }) },
      env.isLocal && { label: isDefault ? 'Clear default' : 'Make default', icon: Star, onSelect: () => defaults.setDefault(isDefault ? null : p.dir) },
      { label: 'Remove…', icon: Trash, danger: true, disabled: busy, onSelect: () => appraiseThenConfirm(p.dir) },
    ]
  }

  const errorProject = ops.error ? projects.data?.find((p) => p.dir === ops.error!.dir) : undefined
  const addButton = <Button variant="primary" icon={Plus} onClick={() => setPanel({ kind: 'add' })}>Add project</Button>

  return (
    <Stack gap={20}>
      <FormGroup title="Clones">
        <CloneBaseRow value={baseDir} onChange={setBaseDir} />
      </FormGroup>
      <ErrorText>{projects.error}</ErrorText>
      {ops.error && !(panelProject && panelProject.dir === ops.error.dir) && <ErrorText>{errorProject ? `${errorProject.displayName}: ` : ''}{ops.error.message}</ErrorText>}
      {/* Search for a per-project setting lands on the list: its rows open the detail that holds it. */}
      <div data-settings-anchor="project-profile">
        <div data-settings-anchor="workspace-folders">
          <DataList
            label="Projects"
            title="Projects"
            description={`Repositories on ${env.label} that conversations can start in.`}
            anchor="projects-list"
            items={rows}
            loading={projects.loading}
            getKey={(r) => r.key}
            noun={['project', 'projects']}
            filter={rowMatches}
            showHeader
            onRowClick={(r) => { if (r.kind === 'project') setPanel({ kind: 'detail', dir: r.project.dir }) }}
            rowMenu={rowMenu}
            actions={addButton}
            columns={[
              { id: 'name', header: 'Name', render: (r) => <NameCell row={r} isDefault={r.kind === 'project' && env.isLocal && defaults.isDefault(r.project.dir)} /> },
              { id: 'branch', header: 'Branch', width: 'minmax(0, 110px)', render: (r) => <BranchCell row={r} /> },
              { id: 'status', header: 'Status', width: 'auto', render: (r) => <StatusCell row={r} /> },
              { id: 'path', header: 'Path', width: 'minmax(0, 1.2fr)', render: (r) => <PathCell row={r} /> },
            ]}
            empty={<EmptyState icon={FolderPlus} title={`No projects on ${env.label} yet`} detail="Add one to start a conversation there." action={addButton} />}
          />
        </div>
      </div>
      {env.isLocal && <ManagedProjectsList />}
      <AddProjectPanel open={panel?.kind === 'add'} baseDir={baseDir} existing={projects.data ?? []} onClose={() => setPanel(null)} onDone={() => { setPanel(null); projects.refresh() }} />
      {panel?.kind === 'detail' && panelProject && (
        <ProjectDetailPanel
          project={panelProject}
          job={runningJob(panelProject.dir)}
          ops={ops}
          verbs={verbs}
          onClose={() => setPanel(null)}
          onMove={() => setPanel({ kind: 'move', dir: panelProject.dir })}
          onRemove={() => appraiseThenConfirm(panelProject.dir)}
        />
      )}
      {panel?.kind === 'move' && panelProject && <MoveProjectPanel project={panelProject} ops={ops} verbs={verbs} onClose={() => setPanel(null)} />}
      {panel?.kind === 'remove' && panelProject && <RemoveProjectPanel project={panelProject} choice={panel.choice} ops={ops} verbs={verbs} onClose={() => setPanel(null)} />}
    </Stack>
  )
}

function CloneBaseRow({ value, onChange }: { value: string; onChange(next: string): void }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const commit = (next: string): void => {
    setEditing(false)
    if (next.trim()) onChange(next.trim())
  }
  return (
    <FormRow label="Base folder for clones" description="New clones on this server land under it. Kept on this device." anchor="clone-base">
      {editing ? (
        <TextInput
          aria-label="Base folder for clones"
          mono
          width={240}
          autoFocus
          defaultValue={value}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') { e.stopPropagation(); setEditing(false) }
          }}
        />
      ) : <>
        <MonoLine>{value}</MonoLine>
        <Button onClick={() => setEditing(true)}>Change</Button>
      </>}
    </FormRow>
  )
}

function NameCell({ row, isDefault }: { row: ProjectListRow; isDefault: boolean }): React.JSX.Element {
  const colors = useColors()
  const status = row.kind === 'project' ? projectStatus(row.project, row.job) : jobStatus(row.job)
  return <>
    <StatusDot tone={status.dot} label={status.dotLabel} />
    <CellText>{row.kind === 'project' ? row.project.displayName : jobRowName(row.job)}</CellText>
    {isDefault && <Star size={12} weight="fill" color={colors.accent} aria-label="Default project" />}
  </>
}

function BranchCell({ row }: { row: ProjectListRow }): React.JSX.Element | null {
  if (row.kind === 'job') return row.job.phase === 'running' ? <CellText muted>{row.job.stage}</CellText> : null
  return row.project.branch ? <CellText muted>{row.project.branch}</CellText> : null
}

function StatusCell({ row }: { row: ProjectListRow }): React.JSX.Element | null {
  const status = row.kind === 'project' ? projectStatus(row.project, row.job) : jobStatus(row.job)
  return status.chip ? <Chip tone={status.chipTone}>{status.chip}</Chip> : null
}

function PathCell({ row }: { row: ProjectListRow }): React.JSX.Element {
  if (row.kind === 'project') return <MonoLine>{row.project.dir}</MonoLine>
  const failure = row.job.phase === 'failed' ? row.job.error?.split('\n')[0] : undefined
  return failure ? <CellText muted>{failure}</CellText> : <MonoLine>{row.job.dir}</MonoLine>
}
