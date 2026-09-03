// @vitest-environment jsdom
/**
 * WorktreeRowMenu — land-and-retire covers "nothing to land".
 *
 * A worktree with zero unlanded commits (a mistakenly created worktree, or
 * work abandoned before the first commit) used to disable the row entirely
 * ("Nothing to land"), leaving no menu path to discard it — the operator had
 * to fall back to the separate destructive "Retire" verb, or leave a dead
 * worktree sitting in the inventory. The row is now enabled for this case and
 * says honestly that it discards rather than merges.
 *
 * Regression direction: reverting `canLandWorktree`/`landRefusalReason` to
 * require `unlandedCommitCount > 0` turns every assertion here red — the
 * button becomes disabled with the old "Nothing to land" hint, and the
 * confirm dialog is never reached.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeAppraisalWire, WorktreeInventoryEntry } from '../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  appraise: vi.fn<(worktreePath: string, sourceBranch: string) => Promise<WorktreeAppraisalWire>>(),
  landAndRetireWorktree: vi.fn(async () => ({ ok: true })),
}))

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

const WT = '/Users/dev/.ion/worktrees/ion-empty'
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
        landAndRetireWorktree: mocks.landAndRetireWorktree,
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

/** Clean checkout, known source branch, but nothing has been committed. */
function entry(over: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  return {
    worktreePath: WT,
    branchName: 'wt/ion-empty',
    label: 'ion-empty',
    sourceBranch: 'main',
    head: 'abc1234',
    lastCommitSubject: '',
    isDirty: false,
    unlandedCommitCount: 0,
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
  mocks.landAndRetireWorktree.mockClear()
  mocks.appraise.mockResolvedValue({
    hasUncommittedChanges: false,
    uncommittedPaths: [],
    unlandedCommitCount: 0,
    fullyLanded: true,
    safeToDiscard: true,
  })
  ;(globalThis as unknown as { window: { ion: unknown } }).window.ion = {
    gitWorktreeAppraise: mocks.appraise,
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

describe('WorktreeRowMenu — land-and-retire with nothing to land', () => {
  it('enables the row and labels it as a discard, not a merge', () => {
    render(entry())

    const button = findButton('Retire (nothing to land)')
    expect(button, 'the row must be present and enabled for a clean worktree with zero unlanded commits').toBeDefined()
    expect(button!.disabled).toBe(false)
  })

  it('still disables the row for a dirty checkout, even with nothing landed', () => {
    render(entry({ isDirty: true }))

    // Disabled rows append their hint to the visible text (ContextMenuItem),
    // so the dirty case reads as the label plus the refusal reason.
    const button = findButton('Retire (nothing to land)Commit changes first')
    expect(button, 'the row must still exist so the operator sees why it is refused').toBeDefined()
    expect(button!.disabled).toBe(true)
  })

  it('confirms with wording that says the worktree is discarded, not merged', async () => {
    render(entry())

    await click(findButton('Retire (nothing to land)')!)

    expect(document.body.textContent).toContain('Retire this worktree?')
    const confirmButton = findButton('Retire')
    expect(confirmButton, 'the confirm button must not claim to land anything').toBeDefined()

    await click(confirmButton!)
    expect(mocks.landAndRetireWorktree).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({ worktreePath: WT }),
    )
  })
})
