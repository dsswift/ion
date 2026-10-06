/**
 * A bench named by its branch keeps resolving to a folder after the bench is
 * removed: its last member landed, so the checkout that has the branch holds
 * the same work.
 */
import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IntegrationWorkspace } from '@ion/shared/types'
import { benchOfFolder, checkoutForBranch } from '../bench-source-checkout'
import { makeWorkspace } from '../bench-store'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' })
}

let root: string
let repo: string
let benchDir: string

const bench = (over: Partial<IntegrationWorkspace> = {}): IntegrationWorkspace => ({ ...makeWorkspace(repo, 'josh'), benchPath: benchDir, lastBuiltAt: 1, ...over })

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-bench-source-')))
  repo = join(root, 'ion')
  execFileSync('git', ['init', '-b', 'main', repo], { encoding: 'utf-8' })
  git(repo, 'config', 'user.email', 'dev@example.com')
  git(repo, 'config', 'user.name', 'Dev')
  git(repo, 'commit', '--allow-empty', '-m', 'base')
  git(repo, 'branch', 'josh')
  benchDir = join(root, 'integration', 'ion-josh')
})
afterEach(() => removeGitFixture(root))

describe('checkoutForBranch', () => {
  it('is the bench while one is built', async () => {
    mkdirSync(benchDir, { recursive: true })
    expect(await checkoutForBranch({ repoPath: repo, branch: 'josh' }, [bench()])).toEqual({ ok: true, path: benchDir, via: 'bench' })
  })

  it('is the checkout that has the branch once the bench is gone, recorded or not', async () => {
    git(repo, 'checkout', 'josh')
    expect(await checkoutForBranch({ repoPath: repo, branch: 'josh' }, [bench()])).toEqual({ ok: true, path: repo, via: 'branch' })
    expect(await checkoutForBranch({ repoPath: repo, branch: 'josh' }, [])).toEqual({ ok: true, path: repo, via: 'branch' })

    git(repo, 'checkout', 'main')
    const worktree = join(root, 'wt-josh')
    git(repo, 'worktree', 'add', worktree, 'josh')
    expect(await checkoutForBranch({ repoPath: repo, branch: 'josh' }, [])).toEqual({ ok: true, path: worktree, via: 'branch' })
  })

  it('says why when nothing holds the branch, or the bench holds nothing', async () => {
    const none = await checkoutForBranch({ repoPath: repo, branch: 'josh' }, [])
    expect(none).toMatchObject({ ok: false })
    expect(!none.ok && none.error).toContain('josh is not checked out')

    mkdirSync(benchDir, { recursive: true })
    const failed = await checkoutForBranch({ repoPath: repo, branch: 'josh' }, [bench({ lastAssembly: 'failed' })])
    expect(!failed.ok && failed.error).toContain('failed to assemble')
  })
})

describe('benchOfFolder', () => {
  it('names the bench a folder is, by its repository and branch', () => {
    expect(benchOfFolder(`${benchDir}/`, [bench()])).toEqual({ repoPath: repo, branch: 'josh' })
    expect(benchOfFolder(repo, [bench()])).toBeNull()
  })
})
