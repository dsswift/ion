/**
 * ProjectPanels — the side panels a project row opens: the project's
 * detail (checkout facts, trust, setup, and on this device the default,
 * profile, and workspace folders), Change location, and the Remove
 * confirmation whose choices depend on what removing would touch.
 */
import React from 'react'
import { ArrowsClockwise, FolderSimpleDashed, ShieldCheck, Trash, Wrench } from '@phosphor-icons/react'
import type { EnvironmentJob, EnvironmentProject } from '@ion/shared/types-environment-admin'
import { useSettingsEnvironment } from '../settings-servers'
import { Button, ErrorText, FormGroup, FormRow, MonoLine, Muted, SidePanel, Stack, Switch } from '../kit'
import { DirectoryPicker } from './DirectoryPicker'
import { ProjectProfileSelect, WorkspaceFolders, useDefaultProject } from './project-local'
import { setupBlockedReason, type ProjectOperations, type ProjectVerbs, type RemovalChoice } from './project-operation'

interface PanelBase { project: EnvironmentProject; ops: ProjectOperations; verbs: ProjectVerbs; onClose(): void }

function setupDescription(project: EnvironmentProject, job: EnvironmentJob | undefined): string {
  if (job) return `${job.kind === 'clone' ? 'Cloning' : 'Running setup'}: ${job.stage}${job.percent !== undefined ? ` ${job.percent}%` : ''}${job.detail ? `. ${job.detail}` : ''}`
  switch (project.setup?.state) {
    case 'running': return 'Setup is running.'
    case 'ready': return 'The last setup succeeded.'
    case 'failed': return `The last setup failed${project.setup.detail ? `: ${project.setup.detail}` : '.'}`
    default: return project.setupCommand ? `Runs ${project.setupCommand}.` : 'The project declares no setup command.'
  }
}

export function ProjectDetailPanel({ project, job, ops, verbs, onClose, onMove, onRemove }: PanelBase & {
  job: EnvironmentJob | undefined
  onMove(): void
  onRemove(): void
}): React.JSX.Element {
  const env = useSettingsEnvironment()
  const defaults = useDefaultProject()
  const busy = ops.busy(project.dir)
  const untrusted = project.trusted === false
  const blocked = setupBlockedReason(project)
  const isDefault = defaults.isDefault(project.dir)
  return (
    <SidePanel
      open
      title={project.displayName}
      subtitle={<MonoLine>{project.dir}</MonoLine>}
      onClose={onClose}
      footer={<>
        <Button variant="danger" icon={Trash} disabled={busy} onClick={onRemove}>Remove…</Button>
        <Button icon={FolderSimpleDashed} disabled={busy || !project.exists} onClick={onMove}>Change location…</Button>
        <Button icon={ArrowsClockwise} disabled={busy || !project.isGitRepo || !project.originUrl} tooltip="Test that origin answers with this server's credentials" onClick={() => verbs.fetch(project)}>Fetch from origin</Button>
      </>}
    >
      <Stack gap={16}>
        {ops.error?.dir === project.dir && <ErrorText>{ops.error.message}</ErrorText>}
        <FormGroup title="Checkout">
          <FormRow label="Branch" description={!project.exists ? 'The folder is missing on disk.' : undefined}>
            <Muted>{project.isGitRepo ? project.branch ?? 'detached' : 'not a git checkout'}</Muted>
          </FormRow>
          <FormRow label="Origin">{project.originUrl ? <MonoLine>{project.originUrl}</MonoLine> : <Muted>none</Muted>}</FormRow>
          <FormRow label="Cloned by Ion"><Muted>{project.entry.clonedByIon ? 'Yes' : 'No'}</Muted></FormRow>
        </FormGroup>
        <FormGroup title="Code">
          <FormRow
            label="Trust"
            description={untrusted
              ? <>Ion cloned this project and runs none of its code until you trust it{project.setupCommand ? <>, including its setup: <Muted mono>{project.setupCommand}</Muted></> : ''}.</>
              : "Ion runs this project's code, including its setup."}
          >
            {untrusted && <Button icon={ShieldCheck} disabled={busy || !project.exists} onClick={() => verbs.trust(project)}>Trust project</Button>}
          </FormRow>
          <FormRow label="Setup" description={setupDescription(project, job)} warning={project.setup?.state === 'failed' ? 'Setup failed' : undefined}>
            <Button icon={Wrench} aria-label={`Run setup for ${project.displayName}`} disabled={busy || blocked !== null} tooltip={blocked ?? "Run the project's setup recipe"} onClick={() => verbs.setup(project)}>Run setup</Button>
          </FormRow>
        </FormGroup>
        {env.isLocal && (
          <FormGroup title="On this device">
            <FormRow label="Default project" description="The project New Conversation opens in by default.">
              <Switch label="Default project" checked={isDefault} onChange={(next) => defaults.setDefault(next ? project.dir : null)} />
            </FormRow>
            <FormRow label="Profile" description="What New Conversation starts with in this project." anchor="project-profile">
              <ProjectProfileSelect dir={project.dir} displayName={project.displayName} />
            </FormRow>
            <FormRow label="Workspace folders" description="Folders every checkout of this project mounts beside it." stacked anchor="workspace-folders">
              <WorkspaceFolders dir={project.dir} displayName={project.displayName} />
            </FormRow>
          </FormGroup>
        )}
      </Stack>
    </SidePanel>
  )
}

export function MoveProjectPanel({ project, ops, verbs, onClose }: PanelBase): React.JSX.Element {
  const env = useSettingsEnvironment()
  return (
    <SidePanel
      open
      title={`Change location of ${project.displayName}`}
      subtitle={`Pick the folder to move this project INTO. It moves as ${project.displayName} inside it and every worktree cut from it follows.`}
      onClose={onClose}
    >
      <DirectoryPicker
        environmentId={env.id}
        initialPath={`${project.dir.replace(/\/[^/]+$/, '')}/`}
        pickLabel="Move here"
        disabled={ops.busy(project.dir)}
        onPick={(parent) => { onClose(); verbs.relocate(project, parent) }}
      />
    </SidePanel>
  )
}

export function RemoveProjectPanel({ project, choice, verbs, onClose }: PanelBase & { choice: RemovalChoice }): React.JSX.Element {
  const risky = choice.dirty || choice.worktrees > 0
  const remove = (deleteFiles: boolean): void => { onClose(); verbs.remove(project, choice, deleteFiles) }
  return (
    <SidePanel
      open
      title={`Remove ${project.displayName}?`}
      subtitle={<MonoLine>{project.dir}</MonoLine>}
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Keep</Button>
        <Button variant="danger" onClick={() => remove(false)}>Remove from list</Button>
        {choice.clonedByIon && <Button variant="danger" onClick={() => remove(true)}>{risky ? 'Delete files anyway' : 'Remove and delete files'}</Button>}
      </>}
    >
      <Stack gap={8}>
        <Muted>
          Remove {project.displayName} from this environment's projects?
          {choice.clonedByIon ? ' Ion cloned this checkout, so you can also delete the files.' : ' The folder stays where it is; Ion only forgets it.'}
        </Muted>
        {choice.dirty && <Muted>It has uncommitted changes.</Muted>}
        {choice.worktrees > 0 && <Muted>{choice.worktrees} worktree(s) were cut from it.</Muted>}
      </Stack>
    </SidePanel>
  )
}
