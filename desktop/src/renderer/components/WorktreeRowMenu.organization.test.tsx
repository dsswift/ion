// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeAppraisalWire, WorktreeInventoryEntry } from '../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  appraise: vi.fn<(worktreePath: string, sourceBranch: string) => Promise<WorktreeAppraisalWire>>(),
  newWorktreeConversation: vi.fn(async () => undefined),
  setWorktreeStage: vi.fn(async () => undefined),
  selectTab: vi.fn(),
  syncWorktree: vi.fn(async () => ({ ok: true })),
  reprovisionWorktree: vi.fn(async () => ({ ok: true })),
  benchAddMember: vi.fn(async () => ({ ok: true })),
  retireWorktree: vi.fn(async () => ({ ok: true, workingDirectory: '/repo' })),
  landAndRetireWorktree: vi.fn(async () => ({ ok: true })),
  recordConflictAlert: vi.fn(),
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

const WT = '/Users/dev/.ion/worktrees/ion-menu'
const REPO = '/Users/dev/src/ion'
let tabs: Array<{ id: string; workingDirectory: string; title: string; customTitle: null; status: string }> = []

vi.mock('../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (state: { benchWorkspaces: Map<string, never>; tabs: typeof tabs }) => unknown) =>
      selector({ benchWorkspaces: new Map<string, never>(), tabs }),
    {
      getState: () => ({
        tabs,
        conversationPanes: new Map(),
        newWorktreeConversation: mocks.newWorktreeConversation,
        setWorktreeStage: mocks.setWorktreeStage,
        selectTab: mocks.selectTab,
        syncWorktree: mocks.syncWorktree,
        reprovisionWorktree: mocks.reprovisionWorktree,
        benchAddMember: mocks.benchAddMember,
        retireWorktree: mocks.retireWorktree,
        landAndRetireWorktree: mocks.landAndRetireWorktree,
        recordConflictAlert: mocks.recordConflictAlert,
      }),
    },
  ),
}))

vi.mock('../rendererLogger', () => ({
  rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn(),
}))

import { PopoverLayerProvider } from './PopoverLayer'
import { WorktreeRowMenu } from './WorktreeRowMenu'

function entry(over: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  return {
    worktreePath: WT,
    branchName: 'wt/ion-menu',
    label: 'ion-menu',
    sourceBranch: 'main',
    head: 'abc1234',
    lastCommitSubject: 'change menu',
    isDirty: true,
    unlandedCommitCount: 0,
    needsSync: false,
    safeToDiscard: false,
    ...over,
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let closed = 0

function Harness({ value }: { value: WorktreeInventoryEntry }): React.JSX.Element | null {
  const [open, setOpen] = React.useState(true)
  if (!open) return null
  return (
    <WorktreeRowMenu
      entry={value}
      anchor={{ x: 10, y: 10 }}
      repoPath={REPO}
      onClose={() => { closed += 1; setOpen(false) }}
      onRefresh={() => {}}
    />
  )
}

function render(value = entry()): void {
  act(() => {
    root.render(<PopoverLayerProvider><Harness value={value} /></PopoverLayerProvider>)
  })
}

function menuButtons(): string[] {
  const menu = document.querySelector('[data-testid="worktree-row-menu"]')
  return [...(menu?.querySelectorAll('button') ?? [])].map((button) => button.textContent?.trim() ?? '')
}

async function press(label: string): Promise<void> {
  const button = [...document.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === label)
  if (!button) throw new Error(`No button labelled ${label}`)
  await act(async () => button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

beforeEach(() => {
  closed = 0
  tabs = []
  mocks.newWorktreeConversation.mockClear()
  mocks.setWorktreeStage.mockClear()
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

describe('WorktreeRowMenu organization', () => {
  it('puts conversation actions first and separates lifecycle groups', () => {
    tabs = [{ id: 'tab-1', workingDirectory: WT, title: 'Current work', customTitle: null, status: 'idle' }]
    render()

    expect(menuButtons()).toEqual([
      'New conversation',
      'Go to tab',
      'Name this worktree',
      'Stage',
      'Add to integration bench',
      'Sync from mainCommit changes first',
      // The fixture is dirty with zero unlanded commits: dirty still refuses
      // (hint stays "Commit changes first"), but with nothing to land the
      // label now says what actually happens — discard, not merge.
      'Retire (nothing to land)Commit changes first',
      'Reveal in Finder',
      'Re-provision',
          ])
    expect(document.querySelectorAll('[data-testid="worktree-menu-separator"]')).toHaveLength(4)
  })

  it('opens the conversation-type picker for the selected worktree', async () => {
    let pickerTarget: unknown
    const pickerListener = vi.fn((event: Event) => {
      pickerTarget = (event as CustomEvent).detail
    })
    window.addEventListener('ion:open-new-conversation-picker', pickerListener)
    render()

    await press('New conversation')

    expect(mocks.newWorktreeConversation).not.toHaveBeenCalled()
    expect(pickerListener).toHaveBeenCalledOnce()
    expect(pickerTarget).toEqual({
      initialDirectory: WT,
      initialWorktree: {
        repoPath: REPO,
        worktreePath: WT,
        branchName: 'wt/ion-menu',
        sourceBranch: 'main',
        landedAt: undefined,
      },
    })
    expect(closed).toBe(1)
    window.removeEventListener('ion:open-new-conversation-picker', pickerListener)
  })

  it('shows the active stage on the trigger and in canonical submenu order', async () => {
    render(entry({ stage: 'test' }))

    expect(menuButtons()[2]).toBe('Stage: Needs testing')
    await press('Stage: Needs testing')

    expect([...document.querySelectorAll('[data-testid="worktree-row-stage-submenu"] button')]
      .map((button) => button.textContent?.trim())).toEqual([
      'Planning', 'Building', 'Needs testing', 'Issue found', 'Verified',
      'Merge checks', 'Ready to land', 'Clear stage',
    ])
    expect(document.querySelector('[data-testid="worktree-stage-active-check"]')).not.toBeNull()
  })

  it('flips the stage submenu inside the right viewport edge', async () => {
    render(entry({ stage: 'test' }))
    const trigger = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Stage: Needs testing') as HTMLElement
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(920, 100, 80, 24))
    const originalRect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement): DOMRect {
      if (this.dataset.testid === 'worktree-row-stage-submenu') return new DOMRect(1008, 100, 180, 260)
      return originalRect.call(this)
    })
    window.innerWidth = 1100

    await press('Stage: Needs testing')

    const submenu = document.querySelector('[data-testid="worktree-row-stage-submenu"]') as HTMLElement
    expect(parseFloat(submenu.style.left)).toBeLessThan(920)
  })

  it('clears the active stage and closes the menu hierarchy', async () => {
    render(entry({ stage: 'test' }))

    await press('Stage: Needs testing')
    await press('Clear stage')

    expect(mocks.setWorktreeStage).toHaveBeenCalledWith(REPO, WT, null)
    expect(closed).toBe(1)
    expect(document.querySelector('[data-testid="worktree-row-menu"]')).toBeNull()
  })
})
