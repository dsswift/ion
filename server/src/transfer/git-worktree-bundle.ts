/**
 * transfer/git-worktree-bundle — the real git plumbing behind export's
 * `isWorktreeDirty`/`buildWorktreeBundle` and import's
 * `checkoutWorktreeFromBundle` parameters (spec 10). Kept separate from
 * `export.ts`/`import.ts` so those stay injectable and testable without a
 * real git repository — this module IS what production wires into them.
 */
import { existsSync, realpathSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { dataDir } from '../paths'
import type { WorktreeInfo } from '@ion/shared/types-session'
import { runGit } from '../git/git-runner'
import { loadRegistry, registerWorktree } from '../worktree/registry'
import type { CheckoutWorktreeResult, CheckoutWorktreeRefusal } from './import'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'transfer.git-worktree-bundle'
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields)
}

/** `true` when `worktreePath` has any uncommitted tracked or untracked change. */
export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const status = await runGit(worktreePath, ['status', '--porcelain', '-uall'])
  return status.trim().length > 0
}

export interface BundleOptions {
  /**
   * Also carry `sourceBranch` itself, for a destination that does not have
   * it (a base branch that only ever lived on the source machine). The
   * bundle then holds both branches minus whatever `knownTips` the
   * destination already has, so it unbundles there without a prior fetch.
   */
  includeSourceBranch?: boolean
  /** Commit shas the destination reported having (`transfer.preflight`); those present here become the bundle's exclusions. */
  knownTips?: string[]
}

/** The shas among `candidates` that exist in `repoPath` as commits — only those can be excluded from a bundle built here. */
export async function commitsPresent(repoPath: string, candidates: string[]): Promise<string[]> {
  const present: string[] = []
  for (const sha of candidates) {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue
    try {
      await runGit(repoPath, ['cat-file', '-e', `${sha}^{commit}`])
      present.push(sha)
    } catch (err) {
      log('known tip absent on source; not excluded', { repo_path: repoPath, sha: sha.slice(0, 12), error: String(err) })
    }
  }
  return present
}

/** Every local and remote-tracking branch tip in `repoPath`, deduplicated: what a destination already has, for the source to exclude. */
export async function branchTips(repoPath: string): Promise<string[]> {
  const out = await runGit(repoPath, ['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/remotes'])
  return [...new Set(out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0))]
}

export async function hasBranch(repoPath: string, branch: string): Promise<boolean> {
  try {
    await runGit(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch (err) {
    log('branch absent', { repo_path: repoPath, branch, error: String(err) })
    return false
  }
}

/**
 * `git bundle create` of what the destination lacks.
 *
 * With `knownTips` (the destination's branch tips from `transfer.preflight`)
 * the bundle carries `branchName` -- and `sourceBranch` too when
 * `includeSourceBranch` -- minus every commit reachable from a tip the
 * destination reported. This is cut against what the destination actually
 * has, not against this machine's copy of the source branch: a destination
 * whose base branch is behind still receives the base commits the worktree
 * was cut from, and one that is ahead is sent nothing it already holds.
 *
 * Without `knownTips` the bundle is thin -- everything on `branchName` not
 * reachable from `sourceBranch` -- and the destination must already have
 * `sourceBranch` at or past the cut point to unbundle it.
 */
export async function buildWorktreeBundle(worktree: WorktreeInfo, options: BundleOptions = {}): Promise<{ bundlePath: string } | null> {
  const dir = await mkdtemp(join(tmpdir(), 'ion-transfer-bundle-'))
  const bundlePath = join(dir, 'worktree.bundle')
  try {
    const knownTips = options.knownTips ?? []
    if (knownTips.length > 0 || options.includeSourceBranch) {
      const exclusions = await commitsPresent(worktree.worktreePath, knownTips)
      const refs = options.includeSourceBranch ? [worktree.sourceBranch, worktree.branchName] : [worktree.branchName]
      log('bundling worktree against the destination\'s tips', { worktree_path: worktree.worktreePath, branch: worktree.branchName, source_branch: worktree.sourceBranch, include_source_branch: !!options.includeSourceBranch, known_tips: knownTips.length, exclusions: exclusions.length })
      await runGit(worktree.worktreePath, ['bundle', 'create', bundlePath, ...refs, ...(exclusions.length > 0 ? ['--not', ...exclusions] : [])])
    } else {
      log('bundling worktree thin against its source branch', { worktree_path: worktree.worktreePath, branch: worktree.branchName, source_branch: worktree.sourceBranch })
      await runGit(worktree.worktreePath, ['bundle', 'create', bundlePath, `${worktree.sourceBranch}..${worktree.branchName}`])
    }
    if (!existsSync(bundlePath)) {
      warn('bundle create produced no file', { worktree_path: worktree.worktreePath, branch: worktree.branchName })
      return null
    }
    return { bundlePath }
  } catch (err) {
    warn('bundle create failed', { worktree_path: worktree.worktreePath, branch: worktree.branchName, error: String(err) })
    await rm(dir, { recursive: true, force: true })
    return null
  }
}

/** `realpath` when the path exists, else the path itself: git reports resolved paths, the registry stores them as given. */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // silent-ok: a path that no longer exists has no real path; compare it as spelled
    return path
  }
}

/**
 * The checkout in `repoPath` that has `branch` checked out, from
 * `git worktree list`, or null. Spelled the way the registry records it
 * when it is registered, so callers can look the entry up by the returned
 * path (git resolves symlinks; the registry does not).
 */
export async function worktreePathForBranch(repoPath: string, branch: string): Promise<string | null> {
  const out = await runGit(repoPath, ['worktree', 'list', '--porcelain'])
  let current: string | null = null
  let found: string | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim()
    else if (line === `branch refs/heads/${branch}` && current) { found = current; break }
  }
  if (!found) return null
  const real = canonical(found)
  const registered = loadRegistry().find((e) => canonical(e.worktreePath) === real)
  return registered?.worktreePath ?? found
}

/**
 * Reconstruct a worktree from a bundle on the IMPORTING side.
 *
 * A worktree has one home at a time, so this machine may already hold a
 * copy of the branch: the sealed copy a move left behind (the worktree is
 * coming back), or the checkout an earlier conversation of the same move
 * created moments ago (a sibling arriving). Either way the existing
 * checkout is reused: its branch is set to the bundle's tip with a hard
 * reset -- history may have been rewritten while it lived elsewhere, and
 * the copy here has no commits of its own to lose -- and a `transferredTo`
 * seal on it is lifted. A dirty existing copy is refused rather than reset
 * over.
 *
 * With no copy: verify `sourceBranch` exists locally (the bundle's
 * prerequisite, created from the bundle when it carries it), fetch the
 * bundle's branch into a local ref of the same name (forced, in case a
 * retired copy left an old ref behind), `git worktree add` a fresh checkout
 * under `~/.ion/worktrees/`, and register it so the engine's containment
 * and the desktop's inventory know it.
 */
export async function checkoutWorktreeFromBundle(args: {
  bundlePath: string
  branch: string
  sourceBranch: string
  repoPath: string
  /** The bundle carries `sourceBranch` too (see `BundleOptions.includeSourceBranch`), so a missing source branch is created from it rather than refused. */
  bundleIncludesSourceBranch?: boolean
}): Promise<CheckoutWorktreeResult | CheckoutWorktreeRefusal | null> {
  let existing: string | null = null
  try {
    existing = await worktreePathForBranch(args.repoPath, args.branch)
  } catch (err) {
    warn('checkoutWorktreeFromBundle: worktree list failed; treating the branch as having no checkout', { repo_path: args.repoPath, error: String(err) })
  }
  if (existing && existsSync(existing)) {
    return updateExistingWorktreeFromBundle(existing, args)
  }
  if (existing) {
    log('checkoutWorktreeFromBundle: registered checkout is gone from disk; pruning and restoring fresh', { repo_path: args.repoPath, branch: args.branch, worktree_path: existing })
    try {
      await runGit(args.repoPath, ['worktree', 'prune'])
    } catch (err) {
      warn('checkoutWorktreeFromBundle: worktree prune failed', { repo_path: args.repoPath, error: String(err) })
    }
  }

  if (!(await hasBranch(args.repoPath, args.sourceBranch))) {
    if (!args.bundleIncludesSourceBranch) {
      warn('checkoutWorktreeFromBundle: source branch missing locally and the bundle does not carry it', { repo_path: args.repoPath, source_branch: args.sourceBranch })
      return null
    }
    try {
      await runGit(args.repoPath, ['fetch', args.bundlePath, `${args.sourceBranch}:${args.sourceBranch}`])
      log('source branch created from bundle', { repo_path: args.repoPath, source_branch: args.sourceBranch })
    } catch (err) {
      warn('checkoutWorktreeFromBundle: source branch fetch from bundle failed', { repo_path: args.repoPath, source_branch: args.sourceBranch, error: String(err) })
      return null
    }
  }

  try {
    // Forced: a copy retired earlier may have left the ref behind at an
    // older (or rewritten) tip, and the bundle's tip is the live one.
    await runGit(args.repoPath, ['fetch', args.bundlePath, `+${args.branch}:${args.branch}`])
  } catch (err) {
    warn('checkoutWorktreeFromBundle: fetch from bundle failed', { repo_path: args.repoPath, branch: args.branch, error: String(err) })
    return null
  }

  const worktreePath = join(dataDir(), 'worktrees', args.branch.replace(/[/\\]/g, '-'))
  try {
    await runGit(args.repoPath, ['worktree', 'add', worktreePath, args.branch])
  } catch (err) {
    warn('checkoutWorktreeFromBundle: worktree add failed', { repo_path: args.repoPath, branch: args.branch, worktree_path: worktreePath, error: String(err) })
    return null
  }

  if (!registerWorktree({ worktreePath, repoPath: args.repoPath, branchName: args.branch, sourceBranch: args.sourceBranch })) {
    warn('checkoutWorktreeFromBundle: registry write failed; the checkout exists but Ion does not track it yet', { worktree_path: worktreePath })
  }
  log('worktree restored from bundle', { repo_path: args.repoPath, branch: args.branch, worktree_path: worktreePath })
  return { worktreePath, reused: false }
}

/**
 * Sets an existing checkout of the branch to the bundle's tip. Reached on
 * every conversation of a worktree move after the first: the checkout is
 * already at that tip, so the reset is a no-op and the copy is reused. A
 * checkout that is NOT part of the move in progress is the destination
 * already holding the branch, which the source dialog blocks before any of
 * this runs. See `checkoutWorktreeFromBundle`.
 */
async function updateExistingWorktreeFromBundle(worktreePath: string, args: { bundlePath: string; branch: string; sourceBranch: string; repoPath: string }): Promise<CheckoutWorktreeResult | CheckoutWorktreeRefusal | null> {
  const entry = loadRegistry().find((e) => e.worktreePath === worktreePath)
  log('checkoutWorktreeFromBundle: branch already has a checkout here; updating it in place', { repo_path: args.repoPath, branch: args.branch, worktree_path: worktreePath, registered: !!entry })
  let dirty: boolean
  try {
    dirty = await isWorktreeDirty(worktreePath)
  } catch (err) {
    warn('checkoutWorktreeFromBundle: dirty check on the existing copy failed', { worktree_path: worktreePath, error: String(err) })
    return { refusal: { code: 'worktree_dirty', message: `could not check ${worktreePath} for uncommitted changes: ${String(err)}` } }
  }
  if (dirty) {
    log('checkoutWorktreeFromBundle: refused, existing copy has uncommitted changes', { worktree_path: worktreePath })
    return { refusal: { code: 'worktree_dirty', message: `the copy of ${args.branch} at ${worktreePath} has uncommitted changes; commit or discard them before the worktree can come back` } }
  }
  try {
    await runGit(worktreePath, ['fetch', args.bundlePath, args.branch])
    await runGit(worktreePath, ['reset', '--hard', 'FETCH_HEAD'])
  } catch (err) {
    warn('checkoutWorktreeFromBundle: updating the existing copy from the bundle failed', { worktree_path: worktreePath, branch: args.branch, error: String(err) })
    return null
  }
  if (!entry) {
    if (!registerWorktree({ worktreePath, repoPath: args.repoPath, branchName: args.branch, sourceBranch: args.sourceBranch })) {
      warn('checkoutWorktreeFromBundle: registry write failed for the existing copy', { worktree_path: worktreePath })
    }
  }
  log('existing worktree updated from bundle', { repo_path: args.repoPath, branch: args.branch, worktree_path: worktreePath, reused: true })
  return { worktreePath, reused: true }
}
