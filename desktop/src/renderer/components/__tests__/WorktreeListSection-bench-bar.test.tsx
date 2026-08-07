// @vitest-environment jsdom
//
// WorktreeListSection — the bench bar and the badge-to-dialog routing.
//
// Split from WorktreeListSection.test.tsx (file-size cap) at a natural seam:
// this half is entirely about the bench bar's failure marker and which
// dialog a badge opens, vs. the other half's row/layout/poll concerns. Same
// harness, same mocks — duplicated rather than shared, because vi.mock
// factories must be inline per test file.
import React from 'react'
import { act } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }),
}))
vi.mock('../git/Tooltip', () => ({
  Tooltip: ({ text, children, style }: { text: string; children: React.ReactNode; style?: React.CSSProperties }) =>
    React.createElement('span', { 'data-tooltip': text, style }, children),
}))
vi.mock('../git/HoverCard', () => ({
  HoverCard: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) =>
    React.createElement('span', { style }, children),
}))
// Dialogs portal into the popover layer; each mock renders a distinguishable
// marker so the tests can assert WHICH dialog opened — the bench-conflict
// badge once opened the ConflictsDialog on the bench directory, which probed
// for an in-progress operation that cannot exist there and rendered an empty
// list with a dead Abort.
vi.mock('../git/ConflictsDialog', () => ({
  ConflictsDialog: ({ directory }: { directory: string }) =>
    React.createElement('div', { 'data-testid': 'conflicts-dialog', 'data-directory': directory }),
}))
vi.mock('../git/BenchConflictDialog', () => ({
  BenchConflictDialog: ({ member }: { member: { branchName: string } }) =>
    React.createElement('div', { 'data-testid': 'bench-conflict-dialog', 'data-branch': member.branchName }),
}))
vi.mock('../git/BenchVerificationDialog', () => ({
  BenchVerificationDialog: ({ workspace }: { workspace: { sourceBranch: string } }) =>
    React.createElement('div', { 'data-testid': 'bench-verification-dialog', 'data-branch': workspace.sourceBranch }),
}))
vi.mock('../WorktreeRowMenu', () => ({ WorktreeRowMenu: () => null }))
vi.mock('../PopoverLayer', () => ({
  usePopoverLayer: () => document.body,
}))
vi.mock('../../rendererLogger', () => ({
  rError: vi.fn(), rWarn: vi.fn(), rInfo: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn(),
}))

import {
  REPO, BENCH_PATH, storeState, mountHarness, entry, member, workspace,
} from './worktree-list-harness'
import { WorktreeListSection } from '../WorktreeListSection'

vi.mock('../../stores/sessionStore', async () =>
  (await import('./worktree-list-harness')).sessionStoreMock())

const h = mountHarness((props) => React.createElement(WorktreeListSection, props))
const host = (): HTMLDivElement => h.host
const render = (props: { inBenchFor?: string } = {}): void => h.render(props)
const rows = (): Element[] => h.rows()
const q = (testid: string): HTMLElement | null => h.q(testid)

beforeEach(() => h.setup())
afterEach(() => h.teardown())

describe('WorktreeListSection — the bench bar', () => {
  it('is absent when the repo has no bench', () => {
    render()
    expect(q('bench-assemble')).toBeNull()
  })

  it('appears once a bench exists, above the rows', () => {
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a')])]]])
    render()

    const bar = q('bench-assemble')!
    const firstRow = rows()[0]
    expect(bar).not.toBeNull()
    expect(bar.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('reports memberships whose worktree is gone as a footnote, never as rows', () => {
    // A row implies a directory to open; an absorbed or retired worktree has
    // none. Dropping it silently is what made absorption look like the bench
    // eating a worktree.
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a'), member('vanished')])]]])
    render()

    expect(rows()).toHaveLength(3)
    expect(host().querySelector('[data-testid="worktree-row-wt/vanished"]')).toBeNull()
    expect(q('bench-orphans')!.textContent).toContain('wt/vanished')
  })

  it('reports a failed assembly in the bar instead of the age line', () => {
    // Atomicity: a failed assembly wipes the bench to an empty tree. An
    // operator who switches to it and finds nothing must have been told WHY
    // here — "assembled just now" over an empty bench was the original lie.
    storeState.benchWorkspaces = new Map([[REPO, [{
      ...workspace([member('a', { merge: 'conflicted' })]),
      lastAssembly: 'failed',
      lastAssemblyError: 'wt/a conflicts on 1 file. The bench is empty until this is resolved.',
    }]]])
    render()

    expect(q('bench-assembly-failed')).not.toBeNull()
  })

  it('renders a distinct, clickable marker for a VERIFICATION failure', () => {
    // A verification failure is not a conflict: every member merged (including
    // any replayed recording), and the project's own verify command rejected
    // the tree. It gets its own words AND a button, unlike the plain
    // "assembly failed" span, because there is no conflicted row to point at.
    storeState.benchWorkspaces = new Map([[REPO, [{
      ...workspace([member('a', { merge: 'unbuilt' })]),
      lastAssembly: 'failed',
      lastAssemblyError: 'A recorded conflict resolution failed project verification.',
      lastAssemblyFailure: 'verification',
      lastAssemblyVerification: {
        command: 'npm run typecheck',
        outputTail: 'error TS1109',
        replayedBranches: ['wt/a'],
      },
    }]]])
    render()

    expect(q('bench-assembly-failed')).toBeNull()
    const marker = q('bench-verification-failed')
    expect(marker).not.toBeNull()
    expect(marker!.tagName).toBe('BUTTON')

    act(() => { (marker as HTMLButtonElement).click() })
    const dialog = q('bench-verification-dialog')
    expect(dialog).not.toBeNull()
    expect(dialog!.getAttribute('data-branch')).toBe('josh')
  })

  it('shows the verification-suspect badge on the replayed member\u2019s row, not the assembly-conflict badge', () => {
    storeState.benchWorkspaces = new Map([[REPO, [{
      ...workspace([member('a', { merge: 'unbuilt' })]),
      lastAssembly: 'failed',
      lastAssemblyFailure: 'verification',
      lastAssemblyVerification: {
        command: 'npm run typecheck',
        outputTail: 'error TS1109',
        replayedBranches: ['wt/a'],
      },
    }]]])
    render()

    expect(q('worktree-bench-verification-wt/a')).not.toBeNull()
    expect(q('worktree-bench-conflict-wt/a')).toBeNull()
  })
})

describe('WorktreeListSection — reaching a bench-verification auto-fix conversation', () => {
  // The reported defect: a conflict-auto-fix conversation running against the
  // bench (created by analyzeBenchVerificationFailure) is invisible to
  // openBenchConversation's singleton resolution (pickBenchConversation
  // matches only tabRole 'bench-conversation') and to benchConversations (the
  // operator-only collector feeding the "open ×N" hint and hover card). Before
  // this fix there was NO path from the bench bar to that conversation at all
  // — see worktree-inventory-slice.test.ts and bench-conversation-singleton.test.ts
  // for the store-level pins of the singleton exclusion this button routes
  // around.
  it('offers a "Go to tab" button that lists the auto-fix conversation the chat button cannot reach', () => {
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a')])]]])
    storeState.tabs = [
      { id: 'fix-1', workingDirectory: BENCH_PATH, title: 'Diagnose verification failure', customTitle: null, status: 'running', tabRole: 'conflict-auto-fix' } as never,
    ]
    render()

    const button = q('bench-go-to-tab')
    expect(button).not.toBeNull()

    act(() => { button!.click() })

    // The submenu portals into `document.body` (the mocked PopoverLayer), a
    // SIBLING of `host`, not a descendant — `q()` only searches inside `host`,
    // so this needs the document directly.
    const row = document.querySelector('[data-testid="worktree-go-to-tab-fix-1"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('Diagnose verification failure')

    act(() => { (row as HTMLElement).click() })

    expect(storeState.selectTab).toHaveBeenCalledWith('fix-1')
  })

  it('is absent when nothing is open in the bench', () => {
    storeState.benchWorkspaces = new Map([[REPO, [workspace([member('a')])]]])
    storeState.tabs = []
    render()

    expect(q('bench-go-to-tab')).toBeNull()
  })
})

describe('WorktreeListSection — the bench-conflict badge opens the right dialog', () => {
  // The regression pinned here: the badge used to call
  // `setResolving(benchPath)`, mounting the ConflictsDialog on a directory
  // with no in-progress operation — empty file list, disabled Abort, an alert
  // that looked broken. A bench conflict's evidence is the membership RECORD,
  // so it gets its own dialog fed from the record.
  it('opens the BenchConflictDialog with the conflicted membership, not the ConflictsDialog', () => {
    storeState.benchWorkspaces = new Map([[REPO, [workspace([
      member('a', { merge: 'conflicted', conflictPaths: ['shared.txt'], conflictsWith: ['wt/b'] }),
      member('b'),
    ])]]])
    render()

    act(() => {
      q('worktree-bench-conflict-wt/a')!.click()
    })

    const dialog = q('bench-conflict-dialog')
    expect(dialog).not.toBeNull()
    expect(dialog!.getAttribute('data-branch')).toBe('wt/a')
    expect(q('conflicts-dialog')).toBeNull()
  })

  it('still opens the ConflictsDialog for an in-worktree conflicted operation', () => {
    // The other dialog keeps its real job: a directory with a REAL in-progress
    // operation (a conflicted sync) resolves through the operation-state UI.
    storeState.worktreeInventory = new Map([[REPO, [
      entry('a', { operationState: 'rebasing', conflictedPaths: ['x.ts'] }),
    ]]])
    render()

    act(() => {
      q('worktree-conflict-wt/a')!.click()
    })

    const dialog = q('conflicts-dialog')
    expect(dialog).not.toBeNull()
    expect(dialog!.getAttribute('data-directory')).toBe('/wt/a')
    expect(q('bench-conflict-dialog')).toBeNull()
  })
})
