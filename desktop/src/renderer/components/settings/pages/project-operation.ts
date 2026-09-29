/**
 * project-operation — runs one project verb (trust, setup, fetch, move,
 * remove) with a busy flag per project, an error line naming the project,
 * a log line either way, and a re-list when it lands.
 */
import { useCallback, useState } from 'react'
import type { EnvironmentProject } from '@ion/shared/types-environment-admin'
import { environmentClient } from '../environment/environment-client'
import { rInfo, rWarn } from '../../../rendererLogger'
import { joinPath, pathBasename } from '@ion/shared/paths'

export interface ProjectOperations {
  busy(dir: string): boolean
  /** The last failure, and which project it was about. */
  error: { dir: string; message: string } | null
  clearError(): void
  run(label: string, dir: string, fn: () => Promise<unknown>): void
  fail(dir: string, operation: string, err: unknown): void
}

export function useProjectOperations(environmentId: string, onChanged: () => void): ProjectOperations {
  const [busyDirs, setBusyDirs] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<{ dir: string; message: string } | null>(null)

  const fail = useCallback((dir: string, operation: string, err: unknown): void => {
    rWarn('project-row', 'operation failed', { environment_id: environmentId, dir, operation, error: String(err) })
    setError({ dir, message: err instanceof Error ? err.message : String(err) })
  }, [environmentId])

  const run = useCallback((label: string, dir: string, fn: () => Promise<unknown>): void => {
    setBusyDirs((prev) => new Set(prev).add(dir))
    setError(null)
    fn().then(() => {
      rInfo('project-row', 'operation done', { environment_id: environmentId, dir, operation: label })
      onChanged()
    }).catch((err: unknown) => fail(dir, label, err)).finally(() => {
      setBusyDirs((prev) => { const next = new Set(prev); next.delete(dir); return next })
    })
  }, [environmentId, onChanged, fail])

  return { busy: (dir) => busyDirs.has(dir), error, clearError: () => setError(null), run, fail }
}

export interface RemovalChoice { clonedByIon: boolean; dirty: boolean; worktrees: number }

/** The verbs a project row and its detail panel share. */
export function projectVerbs(environmentId: string, ops: ProjectOperations) {
  return {
    trust: (p: EnvironmentProject) => ops.run('trusted', p.dir, () => environmentClient.trustProject(environmentId, p.dir)),
    setup: (p: EnvironmentProject) => ops.run('setup started', p.dir, () => environmentClient.setupProject(environmentId, p.dir)),
    fetch: (p: EnvironmentProject) => ops.run('fetch tested', p.dir, async () => {
      const test = await environmentClient.gitTest(environmentId, p.originUrl ?? '')
      if (!test.ok) throw new Error(test.error ?? 'origin unreachable')
    }),
    relocate: (p: EnvironmentProject, parent: string) => ops.run('relocated', p.dir, () => environmentClient.relocateProject(environmentId, p.dir, joinPath(parent.replace(/[\\/]$/, ''), pathBasename(p.dir)))),
    remove: (p: EnvironmentProject, choice: RemovalChoice, deleteFiles: boolean) => deleteFiles
      ? ops.run('removed with files', p.dir, () => environmentClient.removeProject(environmentId, p.dir, { deleteFiles: true, force: choice.dirty || choice.worktrees > 0 }))
      : ops.run('removed', p.dir, () => environmentClient.removeProject(environmentId, p.dir)),
    /** Asks the server what removing would touch; the answer decides which choices the confirmation offers. */
    appraise: (p: EnvironmentProject, then: (choice: RemovalChoice) => void) => {
      void environmentClient.appraiseRemoval(environmentId, p.dir)
        .then((a) => then({ clonedByIon: a.clonedByIon, dirty: a.dirty, worktrees: a.worktrees }))
        .catch((err: unknown) => ops.fail(p.dir, 'appraise removal', err))
    },
  }
}

export type ProjectVerbs = ReturnType<typeof projectVerbs>

/** Why Run setup is unavailable, or null when it can run. */
export function setupBlockedReason(p: EnvironmentProject): string | null {
  if (!p.exists) return 'The folder is missing on disk'
  if (p.trusted === false) return 'Trust the project before running its setup'
  return null
}
