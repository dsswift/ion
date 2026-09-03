// @vitest-environment jsdom
/**
 * WorktreeRowMenu — the land-and-retire confirmation holds its identity.
 *
 * The land half of "Land and retire" drops the worktree's unlandedCommitCount
 * to 0 while the retire half is still running. The dialog used to derive its
 * title and button from the LIVE entry, so it flipped from "Land and retire
 * this worktree?" to "Retire this worktree?" mid-operation — read by the
 * operator as a second confirmation appearing and auto-accepting. The
 * confirmation now freezes its wording and its nothing-to-land flag when it
 * opens, so a later entry refresh cannot change what the dialog says.
 *
 * Regression direction: sourcing `hasNothingToLand` from the live
 * `entry.unlandedCommitCount` again turns the second assertion red — the title
 * flips to "Retire this worktree?" the moment the entry reports zero unlanded
 * commits.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeInventoryEntry } from '../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('framer-motion', () => ({
  motion: {
    div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ children, ...props }, ref) =>
      <div ref={ref} {...props}>{children}</div>),
  },
}))

vi.mock('../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))

vi.mock('../preferences', () => ({
  usePreferencesStore: Object.assign(
    (selector: (state: { worktreeCompletionStrategy: string }) => unknown) =>
      selector({ worktreeCompletionStrategy: 'merge-ff' }),
    { getState: () => ({ uiZoom: 1 }) },
  ),
}))

const WT = '/Users/dev/.ion/worktrees/ion-work'
const REPO = '/Users/dev/src/ion'

vi.mock('../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: { benchWorkspaces: Map<string, never>; tabs: never[]; workspaceOperationLedger: Map<string, never> }) => unknown) =>
      selector({ benchWorkspaces: new Map<string, never>(), tabs: [], workspaceOperationLedger: new Map<string, never>() }),
    {
      getState: () => ({
        tabs: [],
        conversationPanes: new Map(),
        newWorktreeConversation: vi.fn(async () => undefined),
        setWorktreeStage: vi.fn(async () => undefined),
        selectTab: vi.fn(),
        syncWorktree: vi.fn(async () => ({ ok: true })),
        reprovisionWorktree: vi.fn(async () => ({ ok: true })),
        benchAddMember: vi.fn(async () => ({ ok: true })),
        retireWorktree: vi.fn(async () => ({ ok: true, workingDirectory: '/repo' })),
        landAndRetireWorktree: vi.fn(async () => ({ ok: true })),
        recordConflictAlert: vi.fn(),
      }),
    },
  ),
}))

vi.mock('../rendererLogger', () => ({
  rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn(),
}))

import { PopoverLayerProvider } from './PopoverLayer'
import { WorktreeRowMenu } from './WorktreeRowMenu'

/** Clean checkout with work to land, from a known source branch. */
function entry(over: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  return {
    worktreePath: WT,
    branchName: 'wt/ion-work',
    label: 'ion-work',
    sourceBranch: 'main',
    head: 'abc1234',
    lastCommitSubject: 'do the work',
    isDirty: false,
    unlandedCommitCount: 3,
    needsSync: false,
    safeToDiscard: true,
    ...over,
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function render(value: WorktreeInventoryEntry): void {
  act(() => {
    root.render(
      <PopoverLayerProvider>
        <WorktreeRowMenu entry={value} anchor={{ x: 10, y: 10 }} repoPath={REPO} onClose={() => {}} onRefresh={() => {}} />
      </PopoverLayerProvider>,
    )
  })
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

beforeEach(() => {
  ;(globalThis as unknown as { window: { ion: unknown } }).window.ion = {
    gitWorktreeRetirePreview: vi.fn(async () => ({ prunedBenchPaths: [] })),
    revealPath: vi.fn(async () => undefined),
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('WorktreeRowMenu — land-and-retire confirmation is frozen', () => {
  it('keeps the "Land and retire" title after the entry reports nothing left to land', async () => {
    render(entry())

    await click(findButton('Land and retire into main')!)
    expect(document.body.textContent).toContain('Land and retire this worktree?')

    // The land half has completed: the same mounted menu is re-rendered with a
    // refreshed entry that now has zero unlanded commits. The dialog must not
    // change identity while its own operation is still running.
    render(entry({ unlandedCommitCount: 0 }))

    expect(document.body.textContent).toContain('Land and retire this worktree?')
    expect(document.body.textContent).not.toContain('Retire this worktree?')
    expect(findButton('Land and retire'), 'the confirm button keeps its land wording').toBeDefined()
  })
})
