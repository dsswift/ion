// @vitest-environment jsdom
//
// WorktreeRowMenu — "Go to tab" submenu lists every open conversation,
// including a conflict-auto-fix one, and clicking a row focuses it and closes
// the whole menu.
//
// ── The defect ──────────────────────────────────────────────────────────────
// The row's click-cycle and this submenu both used to build their conversation
// list from `collectDirConversations`, which deliberately excludes
// `conflict-auto-fix` tabs (correct for the "open ×N" hint and the hover card,
// which must not count a machine conversation as an operator one). But that
// meant an in-progress auto-fix conversation was invisible to BOTH the row
// click and this submenu — if it moved tab groups, or the operator just needed
// to check on it, there was no way back in from the worktree that owns it.
//
// Regression direction: swap `collectAllDirConversations` back for
// `collectDirConversations` in WorktreeRowMenu.tsx and
// "lists an open conflict-auto-fix conversation" goes red.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WorktreeAppraisalWire } from '../../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  retireWorktree: vi.fn(async () => ({ ok: true, workingDirectory: '/repo' })),
  appraise: vi.fn<(worktreePath: string, sourceBranch: string) => Promise<WorktreeAppraisalWire>>(),
  revealPath: vi.fn(async () => undefined),
  gitWorktreeLand: vi.fn(async () => ({ ok: true })),
  syncWorktree: vi.fn(async () => ({ ok: true })),
  reprovisionWorktree: vi.fn(async () => ({ ok: true })),
  benchAddMember: vi.fn(async () => ({ ok: true })),
  recordConflictAlert: vi.fn(),
  selectTab: vi.fn(),
}))

// Icons deliberately not mocked — see WorktreeRowMenuRetire.test.tsx for why:
// a hand-maintained allowlist breaks the whole file the moment the component
// adds one. Real Phosphor icons render fine (and cheaply) in jsdom.

vi.mock('framer-motion', () => ({
  motion: {
    div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ children, ...props }, ref) =>
      <div ref={ref} {...props}>{children}</div>),
  },
}))

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: Object.assign(
    (selector: (s: { worktreeCompletionStrategy: string }) => unknown) =>
      selector({ worktreeCompletionStrategy: 'merge-ff' }),
    // zoomRect (TabStripShared.ts) reads uiZoom directly off getState() when
    // measuring the "Go to tab" row's bounding rect — unrelated to anything
    // this file exercises, but required for the click handler not to throw.
    { getState: () => ({ uiZoom: 1 }) },
  ),
}))

// The tabs living in this worktree, mutated per test before render.
let storeTabs: Array<{ id: string; workingDirectory: string; title: string; customTitle: string | null; status: string; tabRole?: 'conflict-auto-fix' | 'bench-conversation' | 'verification-analysis' | null }> = []

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: { benchWorkspaces: Map<string, never>; tabs: typeof storeTabs }) => unknown) =>
      selector({ benchWorkspaces: new Map<string, never>(), tabs: storeTabs }),
    {
      getState: () => ({
        retireWorktree: mocks.retireWorktree,
        syncWorktree: mocks.syncWorktree,
        reprovisionWorktree: mocks.reprovisionWorktree,
        benchAddMember: mocks.benchAddMember,
        recordConflictAlert: mocks.recordConflictAlert,
        selectTab: mocks.selectTab,
      }),
    },
  ),
}))

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn(),
}))

import { PopoverLayerProvider } from '../PopoverLayer'
import { WorktreeRowMenu } from '../WorktreeRowMenu'
import { WT, REPO, entry } from './worktree-row-menu-harness'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let closed: number

function Harness(): React.JSX.Element | null {
  const [open, setOpen] = React.useState(true)
  if (!open) return null
  return (
    <WorktreeRowMenu
      entry={entry()}
      anchor={{ x: 10, y: 10 }}
      repoPath={REPO}
      onClose={() => { closed += 1; setOpen(false) }}
      onRefresh={() => {}}
    />
  )
}

function render(): void {
  act(() => {
    root.render(
      <PopoverLayerProvider>
        <Harness />
      </PopoverLayerProvider>,
    )
  })
}

beforeEach(() => {
  closed = 0
  storeTabs = []
  mocks.selectTab.mockClear()
  mocks.appraise.mockClear()
  mocks.appraise.mockResolvedValue({
    hasUncommittedChanges: false, uncommittedPaths: [], unlandedCommitCount: 0,
    fullyLanded: true, safeToDiscard: true,
  })
  ;(globalThis as unknown as { window: { ion: unknown } }).window.ion = {
    gitWorktreeAppraise: mocks.appraise,
    revealPath: mocks.revealPath,
    gitWorktreeLand: mocks.gitWorktreeLand,
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function findButton(label: string): HTMLElement {
  const all = [...document.querySelectorAll('button')]
  const match = all.find((b) => b.textContent?.trim() === label)
  if (!match) throw new Error(`no button labelled "${label}"; saw: ${all.map((b) => b.textContent).join(' | ')}`)
  return match as HTMLElement
}

/**
 * Press an element the way a real pointer does: mousedown, then click.
 *
 * The mousedown is the whole point, mirroring `worktree-row-menu-harness.ts`'s
 * `press()`. `useOutsideDismiss` listens on `mousedown`, not `click` — a test
 * that dispatches `click` alone cannot reproduce the defect this file exists
 * to pin (a submenu row's mousedown reading as "outside the menu" and
 * unmounting the tree before its own click can fire `selectTab`). Dispatching
 * only `click` passes even with the bug present.
 */
async function press(el: HTMLElement): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('WorktreeRowMenu — "Go to tab" submenu', () => {
  it('is absent when nothing is open in this worktree', () => {
    storeTabs = []
    render()
    expect([...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Go to tab'))).toBe(false)
  })

  it('lists an open conflict-auto-fix conversation', async () => {
    // The regression pin: an auto-fix tab is invisible to the row's own
    // "open ×N" hint (collectDirConversations excludes it), but must still
    // appear here (collectAllDirConversations does not).
    storeTabs = [
      { id: 'fix-1', workingDirectory: WT, title: 'Resolve conflict', customTitle: null, status: 'running', tabRole: 'conflict-auto-fix' },
      { id: 'talk-1', workingDirectory: WT, title: 'Add feature', customTitle: null, status: 'idle' },
    ]
    render()

    await press(findButton('Go to tab'))

    expect(document.body.textContent ?? '').toContain('Resolve conflict')
    expect(document.body.textContent ?? '').toContain('Add feature')
  })

  it('focuses the clicked conversation and closes the whole menu', async () => {
    // RED before the containerRef fix: the submenu portals as a sibling of
    // the row menu's root, so a real mousedown on the submenu row read as
    // "outside the menu" to WorktreeRowMenu's own useOutsideDismiss, unmounted
    // the whole tree before the row's click could fire, and `selectTab` was
    // never called — the reported symptom (menu disappears, nothing happens).
    storeTabs = [
      { id: 'fix-1', workingDirectory: WT, title: 'Resolve conflict', customTitle: null, status: 'running', tabRole: 'conflict-auto-fix' },
      { id: 'talk-1', workingDirectory: WT, title: 'Add feature', customTitle: null, status: 'idle' },
    ]
    render()

    await press(findButton('Go to tab'))

    const row = document.querySelector('[data-testid="worktree-go-to-tab-fix-1"]') as HTMLElement
    expect(row).not.toBeNull()
    await press(row)

    expect(mocks.selectTab).toHaveBeenCalledWith('fix-1')
    expect(closed).toBe(1)
    expect(document.querySelector('[data-testid="worktree-row-menu"]')).toBeNull()
    expect(document.querySelector('[data-testid="worktree-row-go-to-tab-submenu"]')).toBeNull()
  })

  it('skips a terminal-only tab even though it shares the worktree directory', async () => {
    storeTabs = [
      { id: 'shell-1', workingDirectory: WT, title: 'Terminal', customTitle: null, status: 'idle', tabRole: null },
      { id: 'talk-1', workingDirectory: WT, title: 'Add feature', customTitle: null, status: 'idle' },
    ]
    // Terminal-only-ness isn't in the fixture's typed shape above; mark it via
    // a cast so this test stays focused on the assertion, not the type.
    ;(storeTabs[0] as unknown as { isTerminalOnly: boolean }).isTerminalOnly = true
    render()

    await press(findButton('Go to tab'))

    expect(document.body.textContent ?? '').not.toContain('Terminal')
    expect(document.body.textContent ?? '').toContain('Add feature')
  })
})
