import { describe, it, expect } from 'vitest'
import { resolveProjectDir, EMPTY_PROJECT_SOURCES, type ProjectResolutionSources } from '../project-workspace'

const REPO = '/Users/dev/source/ion'
const OTHER = '/Users/dev/source/ion-other'

const sources: ProjectResolutionSources = {
  worktrees: [{ worktreePath: '/Users/dev/.ion/worktrees/ion-abc', repoPath: REPO }],
  benches: [{ benchPath: '/Users/dev/.ion/integration/ion-bench', repoPath: REPO }],
  projects: [REPO, OTHER, '/Users/dev/source/ion/packages/inner', '/Users/dev/notes'],
}

describe('resolveProjectDir', () => {
  it('prefers the tab worktree metadata', () => {
    expect(resolveProjectDir('/Users/dev/.ion/worktrees/unknown', { repoPath: REPO }, EMPTY_PROJECT_SOURCES)).toBe(REPO)
  })

  it('resolves a registered worktree by containment', () => {
    expect(resolveProjectDir('/Users/dev/.ion/worktrees/ion-abc', null, sources)).toBe(REPO)
  })

  it('resolves a subdirectory of a worktree', () => {
    expect(resolveProjectDir('/Users/dev/.ion/worktrees/ion-abc/desktop/src', null, sources)).toBe(REPO)
  })

  it('resolves a bench path', () => {
    expect(resolveProjectDir('/Users/dev/.ion/integration/ion-bench/desktop', null, sources)).toBe(REPO)
  })

  it('resolves a registered project directly', () => {
    expect(resolveProjectDir(REPO, null, sources)).toBe(REPO)
  })

  it('picks the longest matching project when projects nest', () => {
    expect(resolveProjectDir('/Users/dev/source/ion/packages/inner/src', null, sources)).toBe('/Users/dev/source/ion/packages/inner')
  })

  it('does not match a sibling whose path merely shares a prefix', () => {
    expect(resolveProjectDir(OTHER, null, sources)).toBe(OTHER)
  })

  it('resolves a non-git project the same way', () => {
    expect(resolveProjectDir('/Users/dev/notes/inbox', null, sources)).toBe('/Users/dev/notes')
  })

  it('answers an unregistered directory with itself', () => {
    expect(resolveProjectDir('/tmp/scratch', null, sources)).toBe('/tmp/scratch')
  })

  it('normalizes trailing slashes', () => {
    expect(resolveProjectDir(REPO + '/', null, sources)).toBe(REPO)
  })

  it('passes through a no-directory tab', () => {
    expect(resolveProjectDir('~', null, sources)).toBe('~')
    expect(resolveProjectDir(null, null, sources)).toBeNull()
  })
})
