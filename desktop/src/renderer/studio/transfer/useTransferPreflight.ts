/**
 * useTransferPreflight — before a Transfer runs, ask the source what the
 * conversation would carry (`transfer.describe`) and the destination
 * whether it can take it (`transfer.preflight`), and turn the answers into
 * a checklist with a fix for each failing row: clone the repo there (and
 * trust it in the same click when it declares code to run), trust a fresh
 * clone before any of its code runs, commit the dirty worktree
 * before a whole-worktree move. The checklist also decides how the
 * export cuts its bundle (carry the source branch when the destination
 * lacks it, excluding the tips it has).
 *
 * Re-asks whenever the destination announces a project change or a job
 * settles, so a "Clone it there" fix flips its row green on its own.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TransferDescription, TransferPreflight, EnvironmentJob, EnvironmentProject } from '@ion/shared/types-environment-admin'
import { PROJECT_JOB_CHANNEL, PROJECTS_CHANGED_CHANNEL } from '@ion/shared/types-environment-admin'
import type { ExportFileOptions } from '@ion/shared/types-transfer'
import { host, action } from '../../host/host-instance'
import { destinationChoices, plainChecks, effectiveProject, type PlainProject } from './plain-destination'
import { setupCheck } from './setup-check'
import { cloneFixes, cloneTrustDetail } from './clone-fixes'
import { archiveVersionCheck } from './archive-version-check'
import { rInfo, rWarn } from '../../rendererLogger'

export type TransferCheckState = 'ok' | 'fixable' | 'blocked' | 'info'

/**
 * What a transfer of a worktree conversation moves: the conversation on its
 * own, leaving the worktree and its other conversations where they are, or
 * the whole worktree as a unit. A conversation with no worktree only ever
 * moves on its own.
 */
export type TransferMode = 'conversation' | 'worktree'

export interface TransferCheck {
  id: 'repo' | 'branch' | 'setup' | 'clean' | 'home' | 'copy' | 'siblings' | 'lands' | 'version'
  state: TransferCheckState
  label: string
  detail: string
  /** The verbs the panel offers for this row, first one first. */
  fixes?: TransferFix[]
}

/** One verb a checklist row offers. */
export interface TransferFix {
  label: string
  run: () => Promise<void>
}

export interface TransferPreflightState {
  loading: boolean
  error: string | null
  description: TransferDescription | null
  preflight: TransferPreflight | null
  checks: TransferCheck[]
  /** True when nothing blocks the transfer. */
  ready: boolean
  /** The project a conversation travelling without its worktree lands in on the destination; empty until one is resolved or chosen. */
  destinationDirectory: string
  /** The destination's checkouts of the conversation's repository, listed first. */
  destinationMatches: string[]
  /** Every other project on the destination. */
  destinationOthers: string[]
  setDestinationDirectory(dir: string): void
  exportOptions: ExportFileOptions
  /** The other conversations in the same worktree, which move too in a whole-worktree move. Empty otherwise. */
  siblingTabIds: string[]
  /** The clone or setup job currently running on the destination for this repo, for the panel's progress line. */
  activeJob: EnvironmentJob | null
  refresh(): void
}

function isStudioEvent(frame: unknown): frame is { type: 'studio_event'; channel: string; payload: unknown } {
  return !!frame && typeof frame === 'object' && (frame as { type?: unknown }).type === 'studio_event'
}

export function useTransferPreflight(
  sourceEnvironmentId: string,
  tabId: string,
  targetEnvironmentId: string,
  targetLabel = 'the destination',
  /** The project this desktop resolved for the conversation from the source's project list; used when the source does not report one. */
  resolvedHere: PlainProject | null = null,
  mode: TransferMode = 'conversation',
  /** The destination's own project list, which says which projects are untrusted clones and what setup each declares. */
  targetProjects: readonly EnvironmentProject[] = [],
): TransferPreflightState {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [description, setDescription] = useState<TransferDescription | null>(null)
  const [preflight, setPreflight] = useState<TransferPreflight | null>(null)
  const [activeJob, setActiveJob] = useState<EnvironmentJob | null>(null)
  const [tick, setTick] = useState(0)
  const [chosenDirectory, setChosenDirectory] = useState('')
  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!targetEnvironmentId) return
    let cancelled = false
    setChosenDirectory('')
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const desc = (await action(sourceEnvironmentId, 'transfer.describe', [{ tabId }])) as TransferDescription
        if (cancelled) return
        setDescription(desc)
        const carries = !!desc.worktree && mode === 'worktree'
        // Both kinds ask, and for the same reason: a conversation's working
        // directory is a path on the machine it is leaving, so the
        // destination is the only side that can say where it lands.
        const sourceRemote = desc.project?.repoRemote ?? ''
        const plainRemote = effectiveProject(desc.project, resolvedHere)?.repoRemote ?? ''
        const query = carries && desc.worktree
          ? { repoRemote: desc.worktree.repoRemote, sourceBranch: desc.worktree.sourceBranch, branch: desc.worktree.branch }
          : { repoRemote: plainRemote, sourceDirectory: desc.project?.workingDirectory ?? '' }
        if (!carries) {
          rInfo('transfer.preflight', 'resolved the repository for a conversation moving on its own', {
            target_environment_id: targetEnvironmentId,
            repo_remote: plainRemote,
            // 'source' = the source reported it; 'this-desktop' = resolved here
            // from the source's project list; 'none' = neither could.
            resolved_by: sourceRemote ? 'source' : plainRemote ? 'this-desktop' : 'none',
            source_reports_project: !!desc.project,
          })
        }
        const pre = (await action(targetEnvironmentId, 'transfer.preflight', [query])) as TransferPreflight
        if (cancelled) return
        setPreflight(pre)
        rInfo('transfer.preflight', 'answered', { target_environment_id: targetEnvironmentId, project_dir: pre.projectDir, project_dir_count: pre.projectDirs.length, has_source_branch: pre.hasSourceBranch, sibling_count: desc.worktree?.siblings.length ?? 0, has_copy: !!pre.worktreeCopy, kind: carries ? 'worktree' : 'conversation', in_worktree: !!desc.worktree, source_archive_version: desc.archiveVersion ?? 1, target_archive_version: pre.archiveVersion ?? 1 })
      } catch (err) {
        if (cancelled) return
        rWarn('transfer.preflight', 'failed', { target_environment_id: targetEnvironmentId, error: String(err) })
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [sourceEnvironmentId, tabId, targetEnvironmentId, tick, resolvedHere, mode])

  // The destination tells us when its registry changes or a job settles.
  useEffect(() => {
    if (!targetEnvironmentId) return
    return host.onFrame((envId, frame) => {
      if (envId !== targetEnvironmentId || !isStudioEvent(frame)) return
      if (frame.channel === PROJECTS_CHANGED_CHANNEL) refresh()
      if (frame.channel === PROJECT_JOB_CHANNEL) {
        const job = frame.payload as EnvironmentJob
        setActiveJob(job.phase === 'running' ? job : null)
        if (job.phase !== 'running') refresh()
      }
    })
  }, [targetEnvironmentId, refresh])

  const carriesWorktree = !!description?.worktree && mode === 'worktree'
  const { matches, others, auto } = useMemo(() => destinationChoices(preflight), [preflight])
  // The resolved directory, unless the operator picked another.
  const destinationDirectory = carriesWorktree ? '' : (chosenDirectory || auto)

  // Trusting is the operator's consent for Ion to run the project's code;
  // the setup it declares runs only after that, never on its own.
  const trustAndSetup = useCallback(async (project: EnvironmentProject) => {
    rInfo('transfer.preflight', 'trust requested', { target_environment_id: targetEnvironmentId, project_dir: project.dir, has_setup: !!project.setupCommand })
    await action(targetEnvironmentId, 'environment.projects.trust', [{ dir: project.dir }])
    if (project.setupCommand) await action(targetEnvironmentId, 'environment.projects.setup', [{ dir: project.dir }])
  }, [targetEnvironmentId])

  // Trust asked with the clone is the operator's yes before anything is
  // fetched: the destination registers it trusted and runs its setup when
  // the clone lands, with no second step.
  const cloneThere = useCallback(async (url: string, parentDir: string, trust: boolean) => {
    rInfo('transfer.preflight', 'clone requested', { target_environment_id: targetEnvironmentId, url_host: url.split(/[@/]/)[1] ?? '', trust })
    await action(targetEnvironmentId, 'environment.projects.clone', [{ url, parentDir, ...(trust ? { trust: true } : {}) }])
  }, [targetEnvironmentId])

  const checks = useMemo<TransferCheck[]>(() => {
    // Nothing else matters when the two ends cannot read each other's archive.
    const version = archiveVersionCheck(description, preflight, targetLabel)
    if (version) return [version]
    const wt = carriesWorktree ? description?.worktree : null
    if (!wt) {
      const project = effectiveProject(description?.project, resolvedHere)
      const rows = plainChecks(
        project,
        preflight,
        destinationDirectory,
        targetLabel,
        project?.originUrl ? cloneFixes(project.provisioning, (trust) => cloneThere(project.originUrl, project.suggestedParentDir, trust)) : [],
        cloneTrustDetail(project?.provisioning),
      )
      const setup = setupCheck(targetProjects.find((p) => p.dir === destinationDirectory), trustAndSetup)
      return setup ? [...rows, setup] : rows
    }
    const out: TransferCheck[] = []
    out.push(wt.siblings.length > 0
      ? { id: 'siblings', state: 'info', label: `Moves the whole worktree: ${wt.siblings.length + 1} conversations`, detail: `Also ${wt.siblings.map((s) => s.title).join(', ')}. The checkout here is removed once they are all across.` }
      : { id: 'siblings', state: 'info', label: 'Moves the whole worktree', detail: 'The checkout here is removed once it is across.' })
    if (wt.dirty) {
      out.push({ id: 'clean', state: 'blocked', label: 'Worktree has uncommitted changes', detail: 'Commit or discard them, then transfer.' })
    } else {
      out.push({ id: 'clean', state: 'ok', label: 'Worktree is clean', detail: wt.branch })
    }
    if (!wt.repoRemote) {
      out.push({ id: 'repo', state: 'blocked', label: 'Repository has no origin', detail: `${wt.repoPath} has no remote, so no other environment can hold a copy.` })
      return out
    }
    if (!preflight) return out
    if (preflight.projectDir) {
      out.push({ id: 'repo', state: 'ok', label: 'Repository is on the destination', detail: preflight.projectDir })
    } else {
      const trustDetail = cloneTrustDetail(wt.provisioning)
      out.push({
        id: 'repo', state: 'fixable', label: 'Repository is not on the destination', detail: trustDetail ? `${wt.repoRemote}. ${trustDetail}` : wt.repoRemote,
        ...(wt.originUrl ? { fixes: cloneFixes(wt.provisioning, (trust) => cloneThere(wt.originUrl, wt.suggestedParentDir, trust)) } : {}),
      })
      return out
    }
    if (preflight.hasSourceBranch) {
      out.push({ id: 'branch', state: 'ok', label: `Base branch ${wt.sourceBranch} is there`, detail: 'Only the commits it lacks travel; its own branch is left where it is.' })
    } else {
      out.push({ id: 'branch', state: 'info', label: `Base branch ${wt.sourceBranch} is not there yet`, detail: 'It will travel with the conversation.' })
    }
    // The destination already has a checkout of this branch. A transfer
    // deletes the worktree it moves, so this is never a leftover copy of
    // the same work — it is a second home, which a move refuses to create.
    if (preflight.worktreeCopy) {
      const copy = preflight.worktreeCopy
      out.push({ id: 'copy', state: 'blocked', label: 'The destination already has this worktree', detail: `${copy.worktreePath} holds this branch; a worktree has one home. Move that one here first, or retire it.` })
    }
    const setup = setupCheck(targetProjects.find((p) => p.dir === preflight.projectDir), trustAndSetup)
    if (setup) out.push(setup)
    return out
  }, [description, preflight, destinationDirectory, targetLabel, resolvedHere, carriesWorktree, targetProjects, trustAndSetup, cloneThere])

  const ready = !loading && !error && checks.every((c) => c.state !== 'blocked' && c.state !== 'fixable')
  // Always cut against what the destination has: a base branch that is
  // behind there still receives the commits the worktree sits on.
  const exportOptions = useMemo<ExportFileOptions>(() => {
    if (!preflight) return {}
    return carriesWorktree ? { includeSourceBranch: !preflight.hasSourceBranch, knownTips: preflight.knownTips, carryWorktree: true } : {}
  }, [preflight, carriesWorktree])
  const siblingTabIds = useMemo(() => (carriesWorktree ? description?.worktree?.siblings.map((s) => s.tabId) ?? [] : []), [description, carriesWorktree])

  return { loading, error, description, preflight, checks, ready, exportOptions, siblingTabIds, activeJob, refresh, destinationDirectory, destinationMatches: matches, destinationOthers: others, setDestinationDirectory: setChosenDirectory }
}
