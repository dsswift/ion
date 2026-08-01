// Shared harness for the WorktreeListSection test files.
//
// The section's tests split across two files (the component's own behaviour, and
// the terminal-is-not-a-conversation rules) because one file outgrew the 600-line
// cap. The fixtures and the mock store they drive must stay identical between
// them -- two copies would drift, and a drifted fixture is how two test files
// come to disagree about what a worktree looks like.
//
// `vi.mock` is deliberately NOT called here: it registers against the calling
// test file's module registry, so each test file declares its own mock block and
// points the sessionStore mock at the `storeState` object exported below.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { vi } from 'vitest'

import type { WorktreeInventoryEntry, IntegrationMember, IntegrationWorkspace } from '../../../shared/types'

/** The props the section takes, so the render helper stays type-checked. */
export interface WorktreeListProps {
  repoPath: string
  refreshKey: number
  inBenchFor?: string
}

export const REPO = '/repo'
export const BENCH_PATH = '/bench/josh'

/** A tab as the section reads it: directory, terminal-ness, and its title. */
export interface HarnessTab {
  id: string
  workingDirectory: string
  isTerminalOnly?: boolean
  customTitle?: string | null
}

export const storeState = {
  worktreeInventory: new Map<string, unknown[]>(),
  benchWorkspaces: new Map<string, unknown[]>(),
  benchSourceTips: new Map<string, unknown>(),
  benchRetired: new Map<string, unknown>(),
  tabs: [] as HarnessTab[],
  // `getTabStatusColor` (reached through `activityFor` -> `getGroupStatusColor`)
  // reads `conversationPanes` off the store directly for the waiting-state and
  // permission-queue folds. An empty Map is the "no instances yet" state and
  // keeps the helper on its idle path.
  conversationPanes: new Map<string, unknown>(),
  refreshWorktreeInventory: vi.fn(),
  refreshBench: vi.fn(),
  openWorktreeConversation: vi.fn(),
  openBenchConversation: vi.fn(),
  openBenchTerminal: vi.fn(),
  syncWorktree: vi.fn(),
  createTabInDirectory: vi.fn(),
  benchAddMember: vi.fn(),
  benchRemoveMember: vi.fn(),
  benchSetEnabled: vi.fn(),
  benchSetReview: vi.fn(),
  benchSetOrder: vi.fn(),
  benchUpdateMember: vi.fn(),
  benchUpdateAll: vi.fn(),
  benchAssemble: vi.fn(),
  benchResolveConflict: vi.fn(async () => null),
  clearBenchRetired: vi.fn(),
}

/** The store mock every WorktreeListSection test file installs. */
export function sessionStoreMock() {
  return {
    useSessionStore: Object.assign(
      (sel: (s: typeof storeState) => unknown) => sel(storeState),
      { getState: () => storeState },
    ),
  }
}

export function entry(n: string, over: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  return {
    worktreePath: `/wt/${n}`,
    branchName: `wt/${n}`,
    label: n,
    sourceBranch: 'josh',
    head: 'abc1234',
    lastCommitSubject: 'feat: things',
    isDirty: false,
    unlandedCommitCount: 0,
    needsSync: false,
    safeToDiscard: false,
    ...over,
  }
}

export function member(n: string, over: Partial<IntegrationMember> = {}): IntegrationMember {
  return {
    worktreePath: `/wt/${n}`,
    branchName: `wt/${n}`,
    enabled: true,
    pin: 'current',
    merge: 'merged',
    pinnedSha: 'abc1234',
    pinnedTreeHash: 't1',
    pinnedBaseSha: 'b1',
    currentTreeHash: 't1',
    ...over,
  }
}

export function workspace(members: IntegrationMember[]): IntegrationWorkspace {
  return {
    repoPath: REPO,
    sourceBranch: 'josh',
    benchPath: BENCH_PATH,
    benchBranch: 'ion/bench/josh',
    members,
    baseSha: 'base1234',
    lastBuiltAt: Date.now(),
  }
}

/**
 * The mount lifecycle and DOM queries the test files share.
 *
 * The ELEMENT to render is passed in rather than imported here: this module is
 * reached from inside the `vi.mock('../../stores/sessionStore')` factory, so
 * importing the component would close a cycle (harness -> component -> mocked
 * store factory -> harness) that hangs the run before any test executes.
 *
 * Returned rather than assigned to module-level `let`s so each test file owns its
 * own host and the two files cannot leak a root into one another.
 */
export function mountHarness(
  element: (props: WorktreeListProps) => unknown,
) {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  return {
    setup(): void {
      vi.clearAllMocks()
      storeState.worktreeInventory = new Map([[REPO, [entry('a'), entry('b'), entry('c')]]])
      storeState.benchWorkspaces = new Map()
      storeState.benchSourceTips = new Map()
      storeState.benchRetired = new Map()
      storeState.tabs = []
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
    },
    teardown(): void {
      act(() => root.unmount())
      host.remove()
    },
    render(props: { inBenchFor?: string } = {}): void {
      act(() => {
        root.render(element({ repoPath: REPO, refreshKey: 0, ...props }) as never)
      })
    },
    get host(): HTMLDivElement { return host },
    rows: (): Element[] => Array.from(host.querySelectorAll('[data-testid^="worktree-row-"]')),
    q: (testid: string): HTMLElement | null => host.querySelector(`[data-testid="${testid}"]`),
  }
}
