/**
 * git-worktree-bundle against real repositories: a thin bundle needs the
 * destination to have the source branch and is refused otherwise; a bundle
 * built with `includeSourceBranch` carries a base branch the destination
 * never had, excludes the tips it reported, and restores both branches
 * there. `branchTips`/`hasBranch`/`commitsPresent` are the preflight's
 * building blocks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildWorktreeBundle, checkoutWorktreeFromBundle, branchTips, hasBranch, commitsPresent } from '../git-worktree-bundle'
import { loadRegistry } from '../../worktree/registry'

let root: string
const originalDataDir = process.env.ION_DATA_DIR
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' }
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env }).trim()
}
function commit(dir: string, file: string): string {
  writeFileSync(join(dir, file), file)
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', file)
  return git(dir, 'rev-parse', 'HEAD')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-bundle-'))
  process.env.ION_DATA_DIR = join(root, 'data')
  mkdirSync(process.env.ION_DATA_DIR)
})
afterEach(() => {
  if (originalDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalDataDir
  rmSync(root, { recursive: true, force: true })
})

/** Source: main -> feature (local only) -> worktree branch off feature. Destination: a clone that has only main. */
function scenario() {
  const source = join(root, 'source')
  mkdirSync(source)
  git(source, 'init', '-q', '-b', 'main')
  const mainSha = commit(source, 'a')
  git(source, 'checkout', '-q', '-b', 'feature')
  const featureSha = commit(source, 'b')
  const wt = join(root, 'wt')
  git(source, 'worktree', 'add', '-q', '-b', 'wt/x', wt, 'feature')
  const wtSha = commit(wt, 'c')
  const dest = join(root, 'dest')
  // --single-branch: the destination knows main only, not even origin/feature.
  git(root, 'clone', '-q', '--branch', 'main', '--single-branch', source, dest)
  return { source, wt, dest, mainSha, featureSha, wtSha }
}

/** Narrows a checkout outcome to the restored shape; a refusal or null fails the assertion that follows. */
function restored(out: Awaited<ReturnType<typeof checkoutWorktreeFromBundle>>): { worktreePath: string; reused?: boolean } | null {
  if (out && 'refusal' in out) throw new Error(`unexpected checkout refusal: ${out.refusal.message}`)
  return out
}

describe('preflight helpers', () => {
  it('report branch tips, branch presence, and which candidate shas exist locally', async () => {
    const s = scenario()
    expect(await hasBranch(s.dest, 'main')).toBe(true)
    expect(await hasBranch(s.dest, 'feature')).toBe(false)
    const tips = await branchTips(s.dest)
    expect(tips).toContain(s.mainSha)
    expect(tips).not.toContain(s.featureSha)
    expect(await commitsPresent(s.wt, [s.mainSha, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'not-a-sha'])).toEqual([s.mainSha])
  })
})

describe('thin bundle', () => {
  it('is refused on a destination that lacks the source branch, and restores on one that has it', async () => {
    const s = scenario()
    const worktree = { worktreePath: s.wt, branchName: 'wt/x', sourceBranch: 'feature', repoPath: s.source }
    const built = await buildWorktreeBundle(worktree)
    expect(built).not.toBeNull()
    expect(await checkoutWorktreeFromBundle({ bundlePath: built!.bundlePath, branch: 'wt/x', sourceBranch: 'feature', repoPath: s.dest })).toBeNull()
    git(s.dest, 'fetch', '-q', s.source, 'feature:feature')
    const out = restored(await checkoutWorktreeFromBundle({ bundlePath: built!.bundlePath, branch: 'wt/x', sourceBranch: 'feature', repoPath: s.dest }))
    expect(out?.worktreePath).toBe(join(root, 'data', 'worktrees', 'wt-x'))
    expect(git(s.dest, 'rev-parse', 'wt/x')).toBe(s.wtSha)
  })
})

describe('bundle with the source branch', () => {
  it('carries a base branch the destination never had, excluding the tips it already has, and restores both', async () => {
    const s = scenario()
    const worktree = { worktreePath: s.wt, branchName: 'wt/x', sourceBranch: 'feature', repoPath: s.source }
    const built = await buildWorktreeBundle(worktree, { includeSourceBranch: true, knownTips: await branchTips(s.dest) })
    expect(built).not.toBeNull()
    const heads = git(s.wt, 'bundle', 'list-heads', built!.bundlePath)
    expect(heads).toContain('refs/heads/feature')
    expect(heads).toContain('refs/heads/wt/x')
    // The bundle's prerequisite is main's tip: nothing the destination has was re-sent.
    expect(git(s.wt, 'bundle', 'verify', built!.bundlePath)).toMatch(new RegExp(s.mainSha.slice(0, 12)))
    const out = restored(await checkoutWorktreeFromBundle({ bundlePath: built!.bundlePath, branch: 'wt/x', sourceBranch: 'feature', repoPath: s.dest, bundleIncludesSourceBranch: true }))
    expect(out).not.toBeNull()
    expect(git(s.dest, 'rev-parse', 'feature')).toBe(s.featureSha)
    expect(git(s.dest, 'rev-parse', 'wt/x')).toBe(s.wtSha)
    expect(existsSync(join(out!.worktreePath, 'c'))).toBe(true)
  })
})

describe('one home per worktree', () => {
  it('cuts the bundle against the destination tips, so a destination whose base branch is behind still restores', async () => {
    const s = scenario()
    // The source's base branch moves on after the worktree was cut; the
    // destination has only the older main. A thin bundle against the
    // source's own main would omit the commits the worktree sits on.
    git(s.source, 'checkout', '-q', 'main')
    commit(s.source, 'd')
    git(s.dest, 'fetch', '-q', s.source, 'feature:feature')
    // Move feature ahead on the source only, so the destination's copy is behind.
    git(s.source, 'checkout', '-q', 'feature')
    const newFeature = commit(s.source, 'e')
    git(s.wt, 'rebase', '-q', 'feature')
    const wtSha = git(s.wt, 'rev-parse', 'HEAD')
    const worktree = { worktreePath: s.wt, branchName: 'wt/x', sourceBranch: 'feature', repoPath: s.source }
    const built = await buildWorktreeBundle(worktree, { knownTips: await branchTips(s.dest) })
    expect(built).not.toBeNull()
    const out = restored(await checkoutWorktreeFromBundle({ bundlePath: built!.bundlePath, branch: 'wt/x', sourceBranch: 'feature', repoPath: s.dest }))
    expect(out?.reused).toBe(false)
    expect(git(s.dest, 'rev-parse', 'wt/x')).toBe(wtSha)
    // The destination's own feature branch is left where it was.
    expect(git(s.dest, 'rev-parse', 'feature')).not.toBe(newFeature)
  })

  it('updates an existing copy in place, and refuses a dirty one', async () => {
    const s = scenario()
    git(s.dest, 'fetch', '-q', s.source, 'feature:feature')
    const worktree = { worktreePath: s.wt, branchName: 'wt/x', sourceBranch: 'feature', repoPath: s.source }
    const first = await buildWorktreeBundle(worktree, { knownTips: await branchTips(s.dest) })
    const landed = restored(await checkoutWorktreeFromBundle({ bundlePath: first!.bundlePath, branch: 'wt/x', sourceBranch: 'feature', repoPath: s.dest }))
    expect(landed?.reused).toBe(false)
    expect(loadRegistry().some((e) => e.worktreePath === landed!.worktreePath)).toBe(true)

    // History is rewritten on the source and the move is run again.
    git(s.wt, 'commit', '-q', '--amend', '-m', 'c-rewritten')
    const rewritten = git(s.wt, 'rev-parse', 'HEAD')
    const second = await buildWorktreeBundle(worktree, { knownTips: await branchTips(s.dest) })
    const back = restored(await checkoutWorktreeFromBundle({ bundlePath: second!.bundlePath, branch: 'wt/x', sourceBranch: 'feature', repoPath: s.dest }))
    expect(back?.reused).toBe(true)
    expect(back?.worktreePath).toBe(landed!.worktreePath)
    expect(git(back!.worktreePath, 'rev-parse', 'HEAD')).toBe(rewritten)

    // A sibling arriving in the same move finds the checkout already current.
    const again = restored(await checkoutWorktreeFromBundle({ bundlePath: second!.bundlePath, branch: 'wt/x', sourceBranch: 'feature', repoPath: s.dest }))
    expect(again?.reused).toBe(true)

    // A dirty copy is never reset over.
    writeFileSync(join(back!.worktreePath, 'scratch'), 'x')
    const refused = await checkoutWorktreeFromBundle({ bundlePath: second!.bundlePath, branch: 'wt/x', sourceBranch: 'feature', repoPath: s.dest })
    expect(refused && 'refusal' in refused ? refused.refusal.code : null).toBe('worktree_dirty')
  })
})
