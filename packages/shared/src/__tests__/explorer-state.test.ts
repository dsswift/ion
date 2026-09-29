import { describe, it, expect } from 'vitest'
import {
  sanitizeExplorerState,
  toPersistedExplorerState,
  forgetExplorerStateUnder,
  pruneExpandedChildren,
  EMPTY_EXPLORER_STATE,
  type ExplorerStateSnapshot,
} from '../explorer-state'

const snapshot: ExplorerStateSnapshot = {
  version: 1,
  expanded: {
    '/repo': ['/repo/src', '/repo/src/renderer'],
    '/home/.ion/worktrees/wt-1': ['/home/.ion/worktrees/wt-1/src'],
    '/lib/shared': ['/lib/shared/a'],
  },
  collapsedRoots: ['/lib/shared', '/home/.ion/worktrees/wt-1'],
  selected: { '/repo': '/repo/readme.md', '/home/.ion/worktrees/wt-1': '/home/.ion/worktrees/wt-1/x.ts' },
}

describe('sanitizeExplorerState', () => {
  it('keeps absolute keys and paths, drops everything else', () => {
    const out = sanitizeExplorerState({
      version: 1,
      expanded: {
        '/repo': ['/repo/src', 'relative', 42, '/repo/bad\npath'],
        'relative-root': ['/x'],
        '/empty': [],
      },
      collapsedRoots: ['/repo', 7, 'relative'],
      selected: { '/repo': '/repo/a.ts', '/bad': 3 },
    })
    expect(out.expanded).toEqual({ '/repo': ['/repo/src'] })
    expect(out.collapsedRoots).toEqual(['/repo'])
    expect(out.selected).toEqual({ '/repo': '/repo/a.ts' })
  })

  it('answers empty for junk rather than throwing', () => {
    expect(sanitizeExplorerState(null)).toEqual(EMPTY_EXPLORER_STATE)
    expect(sanitizeExplorerState([1, 2])).toEqual(EMPTY_EXPLORER_STATE)
  })
})

describe('toPersistedExplorerState', () => {
  it('drops the selection: a highlight from a past launch is noise', () => {
    const persisted = toPersistedExplorerState(snapshot)
    expect(persisted).not.toHaveProperty('selected')
    expect(persisted.expanded).toBe(snapshot.expanded)
    expect(persisted.collapsedRoots).toBe(snapshot.collapsedRoots)
  })
})

describe('forgetExplorerStateUnder', () => {
  it('drops a retired checkout everywhere it appears', () => {
    const out = forgetExplorerStateUnder(snapshot, '/home/.ion/worktrees/wt-1')
    expect(Object.keys(out.expanded)).toEqual(['/repo', '/lib/shared'])
    expect(out.collapsedRoots).toEqual(['/lib/shared'])
    expect(out.selected).toEqual({ '/repo': '/repo/readme.md' })
  })

  it('does not touch a sibling whose path merely shares a prefix', () => {
    const out = forgetExplorerStateUnder(snapshot, '/home/.ion/worktrees/wt')
    expect(out).toBe(snapshot)
  })

  it('returns the same object when nothing matched, so no write happens', () => {
    expect(forgetExplorerStateUnder(snapshot, '/somewhere/else')).toBe(snapshot)
  })
})

describe('pruneExpandedChildren', () => {
  const expanded = ['/repo/src', '/repo/docs', '/repo/src/renderer', '/other/x']

  it('drops a direct child the listing no longer contains', () => {
    const kept = pruneExpandedChildren(expanded, '/repo', ['/repo/src'])
    expect(kept).toEqual(['/repo/src', '/repo/src/renderer', '/other/x'])
  })

  it('leaves deeper paths alone: their own parent listing judges them', () => {
    // '/repo/src/renderer' survives a '/repo' listing even though it is not in
    // it, because only '/repo/src' can disprove it.
    const kept = pruneExpandedChildren(expanded, '/repo', ['/repo/src'])
    expect(kept).toContain('/repo/src/renderer')
    expect(pruneExpandedChildren(kept, '/repo/src', [])).not.toContain('/repo/src/renderer')
  })

  it('leaves paths outside the listed directory alone', () => {
    expect(pruneExpandedChildren(expanded, '/other', ['/other/x'])).toEqual(expanded)
  })
})
