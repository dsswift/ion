// @vitest-environment jsdom
/**
 * The two store actions the shared explorer state added: applying a snapshot
 * from main, and pruning expansions a directory listing disproved.
 */
import { describe, it, expect } from 'vitest'
import { useSessionStore } from '../../sessionStore'

const ROOT = '/repo'

function expandedOf(root: string): string[] {
  return [...(useSessionStore.getState().fileExplorerStates.get(root)?.expandedPaths ?? [])]
}

describe('applyExplorerState', () => {
  it('replaces tree state wholesale, main being the one owner', () => {
    useSessionStore.setState({
      fileExplorerStates: new Map([['/stale', { expandedPaths: new Set(['/stale/x']), selectedPath: null }]]),
      fileExplorerRootCollapsed: new Set(['/stale']),
    })

    useSessionStore.getState().applyExplorerState({
      version: 1,
      expanded: { [ROOT]: ['/repo/src'] },
      collapsedRoots: ['/lib'],
      selected: { [ROOT]: '/repo/readme.md' },
    })

    expect([...useSessionStore.getState().fileExplorerStates.keys()]).toEqual([ROOT])
    expect(expandedOf(ROOT)).toEqual(['/repo/src'])
    expect(useSessionStore.getState().fileExplorerStates.get(ROOT)?.selectedPath).toBe('/repo/readme.md')
    expect([...useSessionStore.getState().fileExplorerRootCollapsed]).toEqual(['/lib'])
  })

  it('keeps a selection whose root has nothing expanded', () => {
    useSessionStore.getState().applyExplorerState({
      version: 1,
      expanded: {},
      collapsedRoots: [],
      selected: { [ROOT]: '/repo/a.ts' },
    })
    expect(useSessionStore.getState().fileExplorerStates.get(ROOT)?.selectedPath).toBe('/repo/a.ts')
  })
})

describe('pruneExplorerExpanded', () => {
  it('drops a remembered folder the listing no longer contains', () => {
    useSessionStore.setState({
      fileExplorerStates: new Map([
        [ROOT, { expandedPaths: new Set(['/repo/src', '/repo/gone']), selectedPath: null }],
      ]),
    })

    useSessionStore.getState().pruneExplorerExpanded(ROOT, ['/repo/src'])

    expect(expandedOf(ROOT)).toEqual(['/repo/src'])
  })

  it('prunes through the ROOT key when the listed directory is nested inside it', () => {
    useSessionStore.setState({
      fileExplorerStates: new Map([
        [ROOT, { expandedPaths: new Set(['/repo/src', '/repo/src/gone']), selectedPath: null }],
      ]),
    })

    useSessionStore.getState().pruneExplorerExpanded('/repo/src', [])

    expect(expandedOf(ROOT)).toEqual(['/repo/src'])
  })

  it('leaves a root that merely shares a path prefix untouched', () => {
    useSessionStore.setState({
      fileExplorerStates: new Map([
        ['/repo-two', { expandedPaths: new Set(['/repo-two/src']), selectedPath: null }],
      ]),
    })

    useSessionStore.getState().pruneExplorerExpanded(ROOT, [])

    expect(expandedOf('/repo-two')).toEqual(['/repo-two/src'])
  })
})
