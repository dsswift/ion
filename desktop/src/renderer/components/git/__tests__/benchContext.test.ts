/**
 * Bench detection for the git panel.
 *
 * Getting the containment test wrong is not a cosmetic bug in either direction:
 * a false negative shows a Changes section in a bench and invites work that the
 * next rebuild destroys; a false positive strips Changes from an ordinary
 * worktree where the operator is doing real work.
 */
import { describe, it, expect } from 'vitest'
import { resolveBenchContext } from '../benchContext'
import type { IntegrationWorkspace } from '../../../../shared/types'

const BENCH = '/Users/test/.ion/integration/ion-josh'
const REPO = '/Users/test/project'

function workspace(over: Partial<IntegrationWorkspace> = {}): IntegrationWorkspace {
  return {
    repoPath: REPO,
    sourceBranch: 'josh',
    benchPath: BENCH,
    benchBranch: 'ion/bench/josh',
    members: [],
    baseSha: 'abc',
    lastBuiltAt: 1,
    ...over,
  } as IntegrationWorkspace
}

describe('resolveBenchContext — inside a bench', () => {
  it('matches the bench root', () => {
    const ctx = resolveBenchContext(BENCH, [workspace()])
    expect(ctx).not.toBeNull()
    expect(ctx!.benchPath).toBe(BENCH)
    expect(ctx!.sourceBranch).toBe('josh')
  })

  it('matches a subdirectory of the bench', () => {
    expect(resolveBenchContext(`${BENCH}/desktop/src`, [workspace()])).not.toBeNull()
  })

  it('carries the member list through', () => {
    const members = [{ worktreePath: '/wt/a', branchName: 'wt/a', label: 'a', pinnedSha: 'x' }] as any
    const ctx = resolveBenchContext(BENCH, [workspace({ members })])
    expect(ctx!.members).toHaveLength(1)
  })

  it('picks the right bench when a repo has several', () => {
    const other = workspace({ benchPath: '/Users/test/.ion/integration/ion-beta', sourceBranch: 'beta' })
    const ctx = resolveBenchContext('/Users/test/.ion/integration/ion-beta/x', [workspace(), other])
    expect(ctx!.sourceBranch).toBe('beta')
  })
})

describe('resolveBenchContext — outside a bench', () => {
  // THE containment case. A bare `startsWith` would match this, and the
  // operator would lose the Changes section in a worktree they are actively
  // committing from.
  it('does NOT match a sibling whose name merely shares the bench prefix', () => {
    expect(resolveBenchContext(`${BENCH}-other`, [workspace()])).toBeNull()
    expect(resolveBenchContext(`${BENCH}-other/src`, [workspace()])).toBeNull()
  })

  it('does not treat a member worktree as a bench', () => {
    expect(resolveBenchContext('/Users/test/.ion/worktrees/ion-a3f1', [workspace()])).toBeNull()
  })

  it('does not treat the repo root as a bench', () => {
    expect(resolveBenchContext(REPO, [workspace()])).toBeNull()
  })

  it('returns null when the repo has no benches', () => {
    expect(resolveBenchContext(BENCH, [])).toBeNull()
    expect(resolveBenchContext(BENCH, undefined)).toBeNull()
  })

  it('returns null for an empty directory', () => {
    expect(resolveBenchContext('', [workspace()])).toBeNull()
  })

  it('ignores a workspace with no benchPath yet', () => {
    expect(resolveBenchContext(BENCH, [workspace({ benchPath: '' })])).toBeNull()
  })
})

describe('resolveBenchContext — separator handling', () => {
  // This module runs in the RENDERER, which Vite bundles for the browser, so it
  // cannot import Node's `path` — that resolves to __vite-browser-external and
  // fails the production build. Both separators are therefore matched
  // explicitly. These tests pin that, because a typecheck and a Node-hosted
  // unit run both pass with the broken import.
  const WIN_BENCH = 'C:\\Users\\test\\.ion\\integration\\ion-josh'

  function winWorkspace(): IntegrationWorkspace {
    return {
      repoPath: 'C:\\Users\\test\\project',
      sourceBranch: 'josh',
      benchPath: WIN_BENCH,
      benchBranch: 'ion/bench/josh',
      members: [],
      baseSha: 'abc',
      lastBuiltAt: 1,
    } as IntegrationWorkspace
  }

  it('matches a Windows bench root', () => {
    expect(resolveBenchContext(WIN_BENCH, [winWorkspace()])).not.toBeNull()
  })

  it('matches a Windows subdirectory', () => {
    expect(resolveBenchContext(`${WIN_BENCH}\\desktop\\src`, [winWorkspace()])).not.toBeNull()
  })

  it('does not match a Windows prefix-sharing sibling', () => {
    expect(resolveBenchContext(`${WIN_BENCH}-other`, [winWorkspace()])).toBeNull()
    expect(resolveBenchContext(`${WIN_BENCH}-other\\src`, [winWorkspace()])).toBeNull()
  })

  it('still requires a separator, not a bare prefix, on POSIX', () => {
    expect(resolveBenchContext(`${BENCH}x`, [workspace()])).toBeNull()
  })
})
