// Shared fixtures for the worktree-inventory slice suites.
//
// The slice's tests are split by concern — inventory/open/new/sync in
// `worktree-inventory-slice.test.ts`, the retire lifecycle in
// `worktree-inventory-retire.test.ts` — but they drive the same slice through
// the same store shape. These helpers are the genuinely common part: the
// inventory-entry fixture, the store harness, and the `window.ion` mock set.
//
// The `vi.mock` factories deliberately stay in each test file. Vitest module
// mocking is per-file and hoisted above imports, so a shared version would not
// apply to the importing suite.
import { vi } from 'vitest'
import { createWorktreeInventorySlice } from '../../slices/worktree-inventory-slice'
import type { WorktreeInventoryEntry } from '../../../../shared/types'

export const REPO = '/Users/test/project'
export const WT_A = '/Users/test/.ion/worktrees/project-a3f1'
export const WT_B = '/Users/test/.ion/worktrees/project-7b0c'
export const BENCH = '/Users/test/.ion/integration/project-josh'
/**
 * Prefix-extension sibling of WT_A: its path STARTS WITH WT_A's.
 *
 * Worktrees are `<repo>-<hex>` siblings in one parent, so this collision is
 * reachable in production. A bare `startsWith` containment check would treat
 * this unrelated worktree's tabs as occupants of WT_A.
 */
export const WT_A_SIBLING = `${WT_A}0`

export function entry(over: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  return {
    worktreePath: WT_A,
    branchName: 'wt/a3f1',
    label: 'project-a3f1',
    sourceBranch: 'josh',
    head: 'abc1234',
    lastCommitSubject: 'fix token expiry',
    isDirty: false,
    unlandedCommitCount: 0,
    needsSync: false,
    safeToDiscard: true,
    ...over,
  }
}

/** Pane fixtures for the close guard, one per way a tab can be busy. */
export const runningPane = {
  instances: [{ id: 'main', statusFields: { state: 'running' }, agentStates: [] }],
}
export const agentsPane = {
  instances: [{
    id: 'main',
    statusFields: { state: 'idle' },
    agentStates: [{ status: 'running' }, { status: 'running' }],
  }],
}
export const shellPane = {
  instances: [{ id: 'main', statusFields: { state: 'idle', backgroundShells: 1 }, agentStates: [] }],
}
export const idlePane = {
  instances: [{ id: 'main', statusFields: { state: 'idle' }, agentStates: [] }],
}

export interface HarnessInit {
  tabs?: Array<Record<string, unknown> & { id: string; workingDirectory: string }>
  activeTabId?: string | null
  /** Panes keyed by tab id, for the close-guard pre-flight. */
  panes?: Map<string, unknown>
  closeIntent?: { tabId: string } | null
}

/** Minimal store harness: the slice only needs these members. */
export function harness(initial: HarnessInit = {}) {
  const state: Record<string, any> = {
    // Tabs carry the fields collectDirConversations reads; the tests supply
    // only id + directory, so fill the display fields in here.
    tabs: (initial.tabs ?? []).map((t) => ({ title: 'New Tab', customTitle: null, status: 'idle', ...t })),
    activeTabId: initial.activeTabId ?? null,
    worktreeInventory: new Map<string, WorktreeInventoryEntry[]>(),
    // Read by the retire pre-flight (evaluateSessionBusyGuard). Absent pane = idle.
    conversationPanes: initial.panes ?? new Map(),
    closeIntent: initial.closeIntent ?? null,
    // Conflict/refusal alert plumbing the slice feeds on sync failures and
    // inventory refreshes (owned by git-conflict-slice in the real store).
    gitConflictAlerts: new Map(),
    recordConflictAlert: vi.fn(),
    clearConflictAlert: vi.fn(),
    selectTab: vi.fn((id: string) => { state.activeTabId = id }),
    // Stands in for the real closeTab, including its GUARD: a blocked tab is
    // left in place. Without that fidelity the relocation-fallback test would
    // pass against a version that never checks anything.
    closeTab: vi.fn((id: string) => {
      const pane = state.conversationPanes.get(id)
      const inst = (pane as { instances?: Array<{ statusFields?: { state?: string; backgroundShells?: number }; agentStates?: Array<{ status?: string }> }> } | undefined)?.instances ?? []
      const busy = inst.some((i) => ['running', 'connecting', 'starting'].includes(i.statusFields?.state ?? '')
        || (i.agentStates ?? []).some((a) => a?.status === 'running')
        || (i.statusFields?.backgroundShells ?? 0) > 0)
      if (busy) return
      state.tabs = state.tabs.filter((t: { id: string }) => t.id !== id)
    }),
    createTabInDirectory: vi.fn(async (dir: string) => {
      const id = `tab-${state.tabs.length + 1}`
      state.tabs = [...state.tabs, { id, workingDirectory: dir, worktree: null, title: 'New Tab', customTitle: null, status: 'idle' }]
      return id
    }),
  }
  const get = () => state as any
  const set = (patch: any) => {
    const next = typeof patch === 'function' ? patch(state) : patch
    Object.assign(state, next)
  }
  const slice = createWorktreeInventorySlice(set as any, get as any)
  Object.assign(state, slice)
  return { state, slice }
}

export const ion = {
  gitWorktreeInventory: vi.fn(),
  gitWorktreeSync: vi.fn(),
  // The REGISTRY lookup, which is where a worktree's owning repo comes from.
  // Deliberately returns a repo that is NOT a key in the inventory cache, so a
  // test cannot pass by accidentally scanning that cache instead.
  gitWorktreeRegistration: vi.fn(),
  gitWorktreeRetire: vi.fn(),
  gitWorktreeRetirePreview: vi.fn(),
  relocateTabSession: vi.fn(),
}

/** Install `window.ion` and the default happy-path resolutions. */
export function resetIon(): void {
  vi.clearAllMocks()
  ;(globalThis as any).window = { ion }
  ion.gitWorktreeInventory.mockResolvedValue({ worktrees: [entry()] })
  ion.gitWorktreeRegistration.mockResolvedValue({
    registration: { repoPath: REPO, branchName: 'wt/a3f1', sourceBranch: 'josh', title: null },
  })
  ion.gitWorktreeSync.mockResolvedValue({ ok: true })
  ion.gitWorktreeRetire.mockResolvedValue({ ok: true, workingDirectory: REPO, prunedBenchPaths: [] })
  ion.gitWorktreeRetirePreview.mockResolvedValue({ prunedBenchPaths: [] })
  ion.relocateTabSession.mockResolvedValue({ ok: true, conversationId: 'conv-1' })
}
