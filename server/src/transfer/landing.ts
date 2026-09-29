/**
 * transfer/landing — where a conversation arriving on this machine lives.
 *
 * A conversation that travels without a worktree used to land in one kind
 * of place: a directory. It can now land in any of three, chosen on the
 * source from what this machine offers:
 *
 * - a project's own checkout, the way it always could;
 * - an existing worktree of that project, when the work belongs there;
 * - a new worktree cut from a branch here, when it deserves its own.
 *
 * Every landing is re-validated against this machine at the moment of
 * import, not trusted from the dialog. A dialog answer can be minutes old: a
 * project removed, a worktree landed, a branch deleted in between. Anything
 * that no longer holds is refused, and nothing is created — a conversation
 * never lands somewhere that is not there.
 *
 * The same resolution serves a move within this machine, which has no
 * archive at all (`relocate`); what differs is only whether files are
 * committed afterwards.
 */
import { existsSync } from 'fs'
import type { WorktreeInfo } from '@ion/shared/types-session'
import type { TransferLanding, TransferLandingOptions } from '@ion/shared/types-transfer'
import { normalizeProjectDir } from '@ion/shared/project-registry'
import { loadRegistry, type RegistryEntry } from '../worktree/registry'
import { gitWorktreeAdd } from '../store/host-api-git'
import { retireWorktree } from '../worktree/relocate'
import { hasBranch } from './git-worktree-bundle'
import { projectsIoFor } from './repo-remote'
import type { TransferPaths } from './paths'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'transfer.landing'
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields)
}

export type Landing = TransferLanding

export interface LandingDeps {
  /** This machine's registered projects, by directory. */
  readProjects: () => Record<string, unknown>
  /** This machine's worktree registry. */
  loadRegistry: () => RegistryEntry[]
  hasBranch: (repoPath: string, branch: string) => Promise<boolean>
  /** Cuts, registers, and provisions a worktree exactly as one made anywhere else in Ion is. */
  createWorktree: (projectDir: string, baseBranch: string) => Promise<{ ok: true; worktree: WorktreeInfo } | { ok: false; error: string }>
  /**
   * Removes a worktree `createWorktree` made, when the import it was made for
   * fails before it finishes. Absent: a failed import leaves it in place.
   */
  discardWorktree?: (worktree: WorktreeInfo) => Promise<void>
}

export type LandingResult =
  | { ok: true; workingDirectory: string; worktree: WorktreeInfo | null }
  | { ok: false; message: string }

/** Parses a landing off the wire. Anything malformed is null, and refused by the caller. */
export function parseLanding(raw: unknown): Landing | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const str = (k: string): string => (typeof r[k] === 'string' ? (r[k] as string) : '')
  if (r.kind === 'checkout' && str('dir')) return { kind: 'checkout', dir: str('dir') }
  if (r.kind === 'worktree' && str('worktreePath')) return { kind: 'worktree', worktreePath: str('worktreePath') }
  if (r.kind === 'new-worktree' && str('projectDir') && str('baseBranch')) return { kind: 'new-worktree', projectDir: str('projectDir'), baseBranch: str('baseBranch') }
  return null
}

function isRegisteredProject(dir: string, deps: LandingDeps): boolean {
  const wanted = normalizeProjectDir(dir)
  return Object.keys(deps.readProjects()).some((p) => normalizeProjectDir(p) === wanted)
}

/**
 * Validates `landing` against this machine and, for a new worktree, creates
 * it. Returns the directory the conversation lives in and the worktree it is
 * bound to, if any.
 */
export async function resolveLanding(landing: Landing, deps: LandingDeps): Promise<LandingResult> {
  if (landing.kind === 'checkout') {
    if (!existsSync(landing.dir)) {
      warn('refused: checkout does not exist here', { kind: landing.kind, dir: landing.dir })
      return { ok: false, message: `${landing.dir} does not exist on this machine` }
    }
    log('landing in a checkout', { dir: landing.dir })
    return { ok: true, workingDirectory: landing.dir, worktree: null }
  }

  if (landing.kind === 'worktree') {
    const entry = deps.loadRegistry().find((e) => e.worktreePath === landing.worktreePath)
    if (!entry) {
      warn('refused: not a registered worktree here', { kind: landing.kind, worktree_path: landing.worktreePath })
      return { ok: false, message: `${landing.worktreePath} is not a worktree on this machine` }
    }
    if (entry.landedAt) {
      warn('refused: worktree has already landed', { kind: landing.kind, worktree_path: entry.worktreePath, landed_at: entry.landedAt })
      return { ok: false, message: `${entry.worktreePath} has already landed and is read-only` }
    }
    if (!existsSync(entry.worktreePath)) {
      warn('refused: worktree checkout is missing', { kind: landing.kind, worktree_path: entry.worktreePath })
      return { ok: false, message: `${entry.worktreePath} is registered but not on disk` }
    }
    if (!isRegisteredProject(entry.repoPath, deps)) {
      warn('refused: worktree belongs to no registered project', { kind: landing.kind, worktree_path: entry.worktreePath, repo_path: entry.repoPath })
      return { ok: false, message: `${entry.worktreePath} belongs to no project on this machine` }
    }
    log('landing in an existing worktree', { worktree_path: entry.worktreePath, branch: entry.branchName })
    return {
      ok: true,
      workingDirectory: entry.worktreePath,
      worktree: { worktreePath: entry.worktreePath, branchName: entry.branchName, sourceBranch: entry.sourceBranch ?? '', repoPath: entry.repoPath },
    }
  }

  if (!isRegisteredProject(landing.projectDir, deps) || !existsSync(landing.projectDir)) {
    warn('refused: new worktree in a project that is not here', { kind: landing.kind, project_dir: landing.projectDir })
    return { ok: false, message: `${landing.projectDir} is not a project on this machine` }
  }
  if (!(await deps.hasBranch(landing.projectDir, landing.baseBranch))) {
    warn('refused: base branch does not exist here', { kind: landing.kind, project_dir: landing.projectDir, base_branch: landing.baseBranch })
    return { ok: false, message: `${landing.projectDir} has no branch ${landing.baseBranch}` }
  }
  const created = await deps.createWorktree(landing.projectDir, landing.baseBranch)
  if (!created.ok) {
    warn('refused: new worktree could not be created', { kind: landing.kind, project_dir: landing.projectDir, base_branch: landing.baseBranch, error: created.error })
    return { ok: false, message: `could not create a worktree: ${created.error}` }
  }
  log('landing in a new worktree', { project_dir: landing.projectDir, base_branch: landing.baseBranch, worktree_path: created.worktree.worktreePath, branch: created.worktree.branchName })
  return { ok: true, workingDirectory: created.worktree.worktreePath, worktree: created.worktree }
}

/**
 * The real dependencies: this machine's project registry and worktree
 * registry, and the same worktree creation every other Ion surface uses, so
 * a worktree a conversation lands in is indistinguishable from one made
 * from the git panel.
 */
export function defaultLandingDeps(paths: TransferPaths): LandingDeps {
  return {
    readProjects: projectsIoFor(paths.settingsFile).readProjects,
    loadRegistry,
    hasBranch,
    createWorktree: async (projectDir, baseBranch) => {
      const result = await gitWorktreeAdd(projectDir, baseBranch)
      if (result.ok && result.worktree) return { ok: true, worktree: result.worktree }
      return { ok: false, error: result.error ?? 'unknown' }
    },
    discardWorktree: async (worktree) => {
      const result = await retireWorktree({ repoPath: worktree.repoPath, worktreePath: worktree.worktreePath, branchName: worktree.branchName })
      if (result.ok) log('new worktree removed after a failed import', { worktree_path: worktree.worktreePath })
      else warn('new worktree could not be removed after a failed import', { worktree_path: worktree.worktreePath, error: result.error ?? '' })
    },
  }
}

/**
 * What `projectDir` on this machine offers a conversation to land in: its
 * live worktrees and the branches a new one could be cut from. Refuses a
 * directory that is not a registered project here, the same as a landing
 * would be.
 */
export async function landingOptionsFor(
  projectDir: string,
  deps: LandingDeps & { listBranches: (dir: string) => Promise<string[]>; currentBranch: (dir: string) => Promise<string | null> },
): Promise<{ ok: true; value: TransferLandingOptions } | { ok: false; message: string }> {
  if (!isRegisteredProject(projectDir, deps) || !existsSync(projectDir)) {
    warn('landing options refused: not a project here', { project_dir: projectDir })
    return { ok: false, message: `${projectDir} is not a project on this machine` }
  }
  const wanted = normalizeProjectDir(projectDir)
  const worktrees = deps.loadRegistry()
    .filter((e) => normalizeProjectDir(e.repoPath) === wanted && !e.landedAt && existsSync(e.worktreePath))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .map((e) => ({ worktreePath: e.worktreePath, branchName: e.branchName, title: e.title ?? null }))
  let branches: string[] = []
  let currentBranch: string | null = null
  try {
    ;[branches, currentBranch] = await Promise.all([deps.listBranches(projectDir), deps.currentBranch(projectDir)])
  } catch (err) {
    // Not a git checkout, or git failed: it still offers its checkout, just
    // no worktrees to cut. Said, not hidden.
    warn('landing options: branches unavailable', { project_dir: projectDir, error: String(err) })
  }
  log('landing options', { project_dir: projectDir, worktree_count: worktrees.length, branch_count: branches.length, current_branch: currentBranch ?? '' })
  return { ok: true, value: { worktrees, branches, currentBranch } }
}
