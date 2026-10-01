import { describe, expect, it, vi } from 'vitest'
import type { EnvironmentProject } from '@ion/shared/types-environment-admin'

vi.mock('../../components/settings/environment/environment-client', () => ({ environmentClient: {}, onEnvironmentEvent: () => () => {} }))

const { buildProjectScopeResolver, normalizeProjectSelection } = await import('./project-identity')

const p = (dir: string, repoRemote?: string): EnvironmentProject => ({ dir, entry: { addedManually: true, lastUsedAt: 0, ...(repoRemote ? { repoRemote } : {}) }, displayName: dir.split('/').pop()!, exists: true, isGitRepo: true })
const byEnvironment = {
  local: [p('/Users/u/src/ion', 'github.com/o/ion'), p('/Users/u/notes')],
  devbox: [p('/home/g/source/ion', 'github.com/o/ion')],
}

describe('project identity', () => {
  it('resolves a checkout to its repository per environment, and leaves an unknown path as itself', () => {
    const scopeOf = buildProjectScopeResolver(byEnvironment)
    expect(scopeOf('/Users/u/src/ion', 'local')).toBe('remote:github.com/o/ion')
    expect(scopeOf('/home/g/source/ion', 'devbox')).toBe('remote:github.com/o/ion')
    // The same path on the wrong machine is not that repository.
    expect(scopeOf('/home/g/source/ion', 'local')).toBe('/home/g/source/ion')
    expect(scopeOf('/Users/u/notes', 'local')).toBe('/Users/u/notes')
  })

  it('normalizes a stored path selection to repository identities once, and returns the same set when nothing changes', () => {
    const stored = new Set(['/Users/u/src/ion', '/Users/u/notes'])
    const next = normalizeProjectSelection(stored, byEnvironment)
    expect([...next].sort()).toEqual(['/Users/u/notes', 'remote:github.com/o/ion'])
    expect(normalizeProjectSelection(next, byEnvironment)).toBe(next)
    const empty = new Set<string>()
    expect(normalizeProjectSelection(empty, byEnvironment)).toBe(empty)
  })
})
