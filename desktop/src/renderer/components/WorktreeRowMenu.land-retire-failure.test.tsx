// @vitest-environment jsdom
/**
 * WorktreeRowMenu — a failed land-and-retire shows its error on its own.
 *
 * The confirmation and the error dialog share one layer. A failed land used to
 * open the error but leave the confirmation up, drawn on top of it, so the
 * operator never saw why the land failed. A failure now closes the
 * confirmation before the error opens, whether the land is refused or throws.
 *
 * Regression direction: dropping `setConfirmRetire(null)` from the failure
 * path leaves "Land and retire this worktree?" in the document beside the
 * error, and both tests turn red.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeInventoryEntry } from '@ion/shared/types'

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

const landAndRetire = vi.hoisted(() => vi.fn())

const WT = '/Users/dev/.ion/worktrees/ion-work'
const REPO = '/Users/dev/src/ion'

vi.mock('@ion/server/store/sessionStore', () => ({
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
        landAndRetireWorktree: landAndRetire,
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

const REFUSAL = 'main is checked out at /Users/dev/src/ion with uncommitted changes. Commit or stash them there, then land again.'

async function confirmLand(): Promise<void> {
  render(entry())
  await click(findButton('Land and retire into main')!)
  expect(document.body.textContent).toContain('Land and retire this worktree?')
  await click(findButton('Land and retire')!)
}

describe('WorktreeRowMenu — a failed land-and-retire shows only its error', () => {
  it('closes the confirmation when the land is refused', async () => {
    landAndRetire.mockResolvedValueOnce({ ok: false, error: REFUSAL })
    await confirmLand()

    expect(document.body.textContent).toContain('Land and retire did not complete')
    expect(document.body.textContent).toContain(REFUSAL)
    expect(document.body.textContent).not.toContain('Land and retire this worktree?')
    expect(document.querySelectorAll('[data-testid="confirm-dialog-backdrop"]')).toHaveLength(1)
  })

  it('closes the confirmation and shows the error when the land throws', async () => {
    landAndRetire.mockRejectedValueOnce(new Error('server went away'))
    await confirmLand()

    expect(document.body.textContent).toContain('Land and retire did not complete')
    expect(document.body.textContent).toContain('server went away')
    expect(document.body.textContent).not.toContain('Land and retire this worktree?')
    expect(document.querySelectorAll('[data-testid="confirm-dialog-backdrop"]')).toHaveLength(1)
  })
})
