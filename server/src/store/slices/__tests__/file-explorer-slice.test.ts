// @vitest-environment jsdom
/**
 * The two store actions the shared explorer state added: applying a snapshot
 * from main, and pruning expansions a directory listing disproved.
 */
import { describe, it, expect, vi } from 'vitest'

// session-store-helpers.ts imports a binary asset (notification.mp3) via a
// relative path that resolves under the desktop package's Vite config but not
// here; this suite exercises unrelated explorer-state actions, so stub it out
// rather than touch the production import.
vi.mock('../../session-store-helpers', () => ({
  makeLocalTab: vi.fn(() => ({
    id: 'initial-tab',
    title: 'New Tab',
    conversationId: null,
    historicalSessionIds: [],
    lastKnownSessionId: null,
    status: 'idle',
    activeRequestId: null,
    lastEventAt: null,
    hasUnread: false,
    currentActivity: '',
    attachments: [],
    lastResult: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    queuedPrompts: [],
    workingDirectory: '~',
    hasChosenDirectory: false,
    additionalDirs: [],
    permissionMode: 'auto',
    bashResults: [],
    bashExecuting: false,
    bashExecId: null,
    pillColor: null,
    forkedFromSessionId: null,
    worktree: null,
    pendingWorktreeSetup: false,
    contextTokens: null,
    contextPercent: null,
    contextWindow: null,
    isCompacting: false,
    isTerminalOnly: false,
    engineProfileId: null,
  })),
  isReusableBlankConversationTab: vi.fn(() => false),
  initialModelOverride: vi.fn(() => null),
  initialPermissionMode: vi.fn(() => 'auto'),
  initialThinkingEffort: vi.fn(() => 'off'),
  nextMsgId: vi.fn(() => `msg-${Math.random().toString(36).slice(2, 8)}`),
  playNotificationIfHidden: vi.fn(async () => {}),
  isTextFile: vi.fn(() => true),
  isEditableByDefault: vi.fn(() => false),
  editorDirForTab: vi.fn(() => ''),
  cancelDoneGroupMove: vi.fn(() => false),
  scheduleDoneGroupMove: vi.fn(),
}))

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

  it('prunes a nested Windows directory through its root', () => {
    const root = 'C:\\repo'
    useSessionStore.setState({
      fileExplorerStates: new Map([
        [root, { expandedPaths: new Set(['C:\\repo\\src', 'C:\\repo\\src\\gone']), selectedPath: null }],
      ]),
    })

    useSessionStore.getState().pruneExplorerExpanded('C:\\repo\\src', [])

    expect(expandedOf(root)).toEqual(['C:\\repo\\src'])
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

describe('collapseAllExplorerRoots', () => {
  const OTHER = '/lib'

  function seed(): void {
    useSessionStore.setState({
      fileExplorerStates: new Map([
        [ROOT, { expandedPaths: new Set(['/repo/src', '/repo/src/deep']), selectedPath: '/repo/src/a.ts' }],
        [OTHER, { expandedPaths: new Set(['/lib/pkg']), selectedPath: null }],
      ]),
      fileExplorerRootCollapsed: new Set<string>(),
    })
  }

  it('folds every folder and every root section when several roots are shown', () => {
    seed()
    useSessionStore.getState().collapseAllExplorerRoots([ROOT, OTHER])
    expect(expandedOf(ROOT)).toEqual([])
    expect(expandedOf(OTHER)).toEqual([])
    expect([...useSessionStore.getState().fileExplorerRootCollapsed].sort()).toEqual([OTHER, ROOT].sort())
    expect(useSessionStore.getState().fileExplorerStates.get(ROOT)?.selectedPath).toBe('/repo/src/a.ts')
  })

  it('folds the folders of a lone root but leaves its section open', () => {
    seed()
    useSessionStore.getState().collapseAllExplorerRoots([ROOT])
    expect(expandedOf(ROOT)).toEqual([])
    expect(expandedOf(OTHER)).toEqual(['/lib/pkg'])
    expect(useSessionStore.getState().fileExplorerRootCollapsed.size).toBe(0)
  })
})
