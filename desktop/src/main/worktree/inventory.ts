/**
 * Worktree inventory — the answer to "what worktrees exist here, and how do I
 * get back into one?"
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 * Closing a worktree conversation used to be a trap. `closeTab` force-removed
 * the worktree, so an accidental close destroyed the work outright. Even once
 * close stops destroying anything (it does now — see the close guard), the
 * conversation is gone and there is no history feature to recover it. The only
 * way back in was to create a tab and manually browse to a path like
 * `~/.ion/worktrees/ion-a3f1` that the operator has no reason to know.
 *
 * So the worktree has to be *discoverable*: list what exists for this repo,
 * with enough state to tell them apart, and let the operator open a fresh
 * conversation directly into one. That is strictly better than forbidding close,
 * which would pin the operator to a single immortal conversation per worktree.
 *
 * ── Source-branch resolution ────────────────────────────────────────────────
 * Every lifecycle verb (land, sync, base staleness) needs to know which branch a
 * worktree was cut FROM, and git does not record that. A worktree created by
 * Ion registers itself here, so the answer is durable and exact.
 *
 * When a worktree has no registry entry — created before this existed, or by
 * hand on the command line — the source branch is REPORTED AS UNKNOWN rather
 * than guessed. A wrong source branch would make "land" merge into the wrong
 * place, which is far worse than asking. Callers surface a picker instead.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { log as _log, warn as _warn } from '../logger'
import { runGit } from '../git-runner'
import { parseWorktreeList } from './integrate'
import { appraiseWorktree } from './safety'
import { appraiseBase } from './base-staleness'

const TAG = 'worktree.inventory'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

// Resolved lazily, not captured at module load: a frozen path is unobservable
// and would make a test that redirects HOME write to the real ~/.ion.
function ionDir(): string { return join(homedir(), '.ion') }
export function worktreeRegistryFile(): string { return join(ionDir(), 'worktree-registry.json') }

interface RegistryEntry {
  worktreePath: string
  repoPath: string
  branchName: string
  /** The branch this worktree was cut from — not recoverable from git. */
  sourceBranch: string
  createdAt: number
}

interface RegistryFile {
  version: 1
  entries: RegistryEntry[]
}

function loadRegistry(): RegistryEntry[] {
  const file = worktreeRegistryFile()
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<RegistryFile>
    return Array.isArray(parsed.entries)
      ? parsed.entries.filter((e): e is RegistryEntry =>
        !!e && typeof e.worktreePath === 'string' && typeof e.sourceBranch === 'string')
      : []
  } catch (err) {
    warn('registry unreadable, treating as empty', { path: file, error: String(err) })
    return []
  }
}

function saveRegistry(entries: RegistryEntry[]): void {
  try {
    const dir = ionDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const payload: RegistryFile = { version: 1, entries }
    atomicWriteFileSync(worktreeRegistryFile(), JSON.stringify(payload, null, 2), 0o644)
  } catch (err) {
    warn('failed to save worktree registry', { path: worktreeRegistryFile(), error: String(err) })
  }
}

/**
 * Record a worktree's source branch. Called from every path that creates a
 * worktree, so the lifecycle verbs always know where it lands.
 */
export function registerWorktree(args: {
  worktreePath: string
  repoPath: string
  branchName: string
  sourceBranch: string
}): void {
  const entries = loadRegistry().filter((e) => e.worktreePath !== args.worktreePath)
  entries.push({ ...args, createdAt: Date.now() })
  saveRegistry(entries)
  log('registered worktree', {
    worktree_path: args.worktreePath,
    branch: args.branchName,
    source_branch: args.sourceBranch,
  })
}

/** Drop a worktree's registry entry (after a retire). */
export function unregisterWorktree(worktreePath: string): void {
  const before = loadRegistry()
  const after = before.filter((e) => e.worktreePath !== worktreePath)
  if (after.length !== before.length) {
    saveRegistry(after)
    log('unregistered worktree', { worktree_path: worktreePath })
  }
}

/** Look up a worktree's recorded source branch, or null when unknown. */
export function lookupSourceBranch(worktreePath: string): string | null {
  return loadRegistry().find((e) => e.worktreePath === worktreePath)?.sourceBranch ?? null
}

/** One worktree, with everything the UI needs to describe and act on it. */
export interface WorktreeInventoryEntry {
  worktreePath: string
  branchName: string
  /** Display label, derived from the worktree directory name. */
  label: string
  /** Null when Ion did not create it and cannot know — callers must ask. */
  sourceBranch: string | null
  /** Short HEAD sha for display. */
  head: string
  /** Latest commit subject, for telling worktrees apart at a glance. */
  lastCommitSubject: string
  /** Uncommitted changes present. */
  isDirty: boolean
  /** Commits not yet landed in the source branch. */
  unlandedCommitCount: number
  /** True when the feature branch has moved ahead and a sync would help. */
  needsSync: boolean
  /** True when removing this worktree would destroy nothing. */
  safeToDiscard: boolean
}

/**
 * List every managed worktree for a repo, enriched with the state needed to
 * pick one and act on it. Read-only.
 *
 * The bench worktree and the repo's own root are excluded: they are not feature
 * worktrees and offering them here would be misleading.
 */
export async function inventoryWorktrees(repoPath: string): Promise<WorktreeInventoryEntry[]> {
  let listed: ReturnType<typeof parseWorktreeList>
  try {
    listed = parseWorktreeList(await runGit(repoPath, ['worktree', 'list', '--porcelain']))
  } catch (err) {
    warn('could not list worktrees', { repo_path: repoPath, error: String(err) })
    return []
  }

  const entries: WorktreeInventoryEntry[] = []
  for (const wt of listed) {
    // Skip the repo root itself and the integration bench.
    if (wt.path === repoPath) continue
    if (wt.branch.startsWith('ion/bench/')) continue
    if (!wt.branch) continue // detached HEAD — not a managed feature worktree

    const sourceBranch = lookupSourceBranch(wt.path)

    let lastCommitSubject = ''
    try {
      lastCommitSubject = (await runGit(wt.path, ['log', '-1', '--format=%s'])).trim()
    } catch (err) {
      log('could not read last commit', { worktree_path: wt.path, error: String(err) })
    }

    // Without a known source branch the land-relative facts are unanswerable.
    // Report what IS knowable and leave the rest conservative.
    let unlandedCommitCount = 0
    let safeToDiscard = false
    let needsSync = false
    let isDirty = false
    if (sourceBranch) {
      const appraisal = await appraiseWorktree(wt.path, sourceBranch)
      isDirty = appraisal.hasUncommittedChanges
      unlandedCommitCount = appraisal.unlandedCommitCount
      safeToDiscard = appraisal.safeToDiscard
      needsSync = (await appraiseBase(wt.path, sourceBranch)).needsSync
    } else {
      try {
        isDirty = (await runGit(wt.path, ['status', '--porcelain'])).trim().length > 0
      } catch (err) {
        log('could not read status', { worktree_path: wt.path, error: String(err) })
      }
    }

    entries.push({
      worktreePath: wt.path,
      branchName: wt.branch,
      label: wt.path.split('/').filter(Boolean).pop() || wt.branch,
      sourceBranch,
      head: wt.head.slice(0, 7),
      lastCommitSubject,
      isDirty,
      unlandedCommitCount,
      needsSync,
      safeToDiscard,
    })
  }

  log('inventoried worktrees', { repo_path: repoPath, count: entries.length })
  return entries
}
