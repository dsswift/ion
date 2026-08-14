// @vitest-environment jsdom
//
// WorktreeRowMenu — clicking an item dismisses the menu.
//
// ── The defect ──────────────────────────────────────────────────────────────
// Dismissal used to be each handler's own business, and the seven items had
// four different behaviours: sync and reveal closed immediately; add-to-bench
// and re-provision closed only after their await resolved, so the menu sat open
// for the whole round-trip; land never closed at all on success; and retire
// waited on the appraisal before its dialog replaced the menu. A menu still on
// screen after a click reads as "the click did nothing" — which is what was
// reported for retire, where the menu sat open while the worktree was deleted
// behind it.
//
// It is now one rule at the button: fire the verb, then close, unless the item
// declares `keepsMenuOpen` because it puts its own UI where the menu was.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WorktreeAppraisalWire, WorktreeInventoryEntry } from '../../../shared/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  retireWorktree: vi.fn(async () => ({ ok: true, workingDirectory: '/repo' } as {
    ok: boolean; workingDirectory?: string; recoveryRef?: string; error?: string
  })),
  appraise: vi.fn<(worktreePath: string, sourceBranch: string) => Promise<WorktreeAppraisalWire>>(),
  revealPath: vi.fn(async () => undefined),
  gitWorktreeLand: vi.fn<(args: unknown) => Promise<{ ok: boolean; error?: string; mode?: string; hasConflicts?: boolean; conflictDirectory?: string }>>(),
  syncWorktree: vi.fn(async () => ({ ok: true })),
  reprovisionWorktree: vi.fn<(repoPath: string, worktreePath: string) => Promise<{ ok: boolean; error?: string }>>(),
  benchAddMember: vi.fn<(...a: unknown[]) => Promise<{ ok: boolean; error?: string }>>(),
  recordConflictAlert: vi.fn(),
  newWorktreeConversation: vi.fn(async () => undefined),
  setWorktreeStage: vi.fn(async () => undefined),
  sealLandedWorktree: vi.fn(async () => undefined),
}))

// Icons are deliberately NOT mocked. The previous mock was a hand-maintained
// allowlist of the icons the component used when the test was written, and it
// broke the entire file the moment WorktreeRowMenu added one: vitest throws
// "No <Name> export is defined on the mock" at render, which reads like a
// component fault rather than a stale fixture, and every test in the file goes
// red at once. Rendering the real Phosphor icons in jsdom is cheap, asserts
// nothing about them, and cannot drift from the component.

vi.mock('framer-motion', () => ({
  motion: {
    div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ children, ...props }, ref) =>
      <div ref={ref} {...props}>{children}</div>),
  },
}))

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))

// `getState` as well as the selector call: the menu's positioning hook reads
// the operator's UI zoom through `usePreferencesStore.getState()` to convert
// between measured viewport pixels and zoomed CSS pixels.
vi.mock('../../preferences', () => ({
  usePreferencesStore: Object.assign(
    (selector: (s: { worktreeCompletionStrategy: string }) => unknown) =>
      selector({ worktreeCompletionStrategy: 'merge-ff' }),
    { getState: () => ({ uiZoom: 1 }) },
  ),
}))

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: { benchWorkspaces: Map<string, never>; tabs: never[] }) => unknown) =>
      selector({ benchWorkspaces: new Map<string, never>(), tabs: [] }),
    {
      getState: () => ({
        retireWorktree: mocks.retireWorktree,
        syncWorktree: mocks.syncWorktree,
        reprovisionWorktree: mocks.reprovisionWorktree,
        benchAddMember: mocks.benchAddMember,
        recordConflictAlert: mocks.recordConflictAlert,
        newWorktreeConversation: mocks.newWorktreeConversation,
        setWorktreeStage: mocks.setWorktreeStage,
        sealLandedWorktree: mocks.sealLandedWorktree,
        // The retire pre-flight reads these to answer "is anything in this
        // worktree still working". No tabs open means nothing is active, which
        // is the state every dismissal test wants.
        tabs: [],
        conversationPanes: new Map(),
      }),
    },
  ),
}))

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn(),
}))

import { PopoverLayerProvider } from '../PopoverLayer'
import { WorktreeRowMenu } from '../WorktreeRowMenu'
import { DIRTY_APPRAISAL, REPO, WT, entry, press } from './worktree-row-menu-harness'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let closed: number

/**
 * Render the menu the way `WorktreesSection` does: it holds the menu in state
 * and renders nothing once `onClose` fires, so closing UNMOUNTS the menu. That
 * fidelity is what makes "the menu is gone" a real assertion.
 */
function Harness({ over }: { over: Partial<WorktreeInventoryEntry> }): React.JSX.Element | null {
  const [open, setOpen] = React.useState(true)
  if (!open) return null
  return (
    <WorktreeRowMenu
      entry={entry(over)}
      anchor={{ x: 10, y: 10 }}
      repoPath={REPO}
      onClose={() => { closed += 1; setOpen(false) }}
      onRefresh={() => {}}
    />
  )
}

/** Render with entry overrides, for the items gated on `isDirty` / unlanded. */
function renderWith(over: Partial<WorktreeInventoryEntry>): void {
  act(() => {
    root.render(
      <PopoverLayerProvider>
        <Harness over={over} />
      </PopoverLayerProvider>,
    )
  })
}

function render(): void {
  renderWith({})
}

beforeEach(() => {
  closed = 0
  mocks.retireWorktree.mockClear()
  mocks.retireWorktree.mockResolvedValue({ ok: true, workingDirectory: '/repo' })
  mocks.appraise.mockClear()
  mocks.appraise.mockResolvedValue(DIRTY_APPRAISAL)
  mocks.revealPath.mockClear()
  mocks.syncWorktree.mockClear()
  mocks.reprovisionWorktree.mockClear()
  mocks.reprovisionWorktree.mockResolvedValue({ ok: true })
  mocks.benchAddMember.mockClear()
  mocks.newWorktreeConversation.mockClear()
  mocks.setWorktreeStage.mockClear()
  mocks.sealLandedWorktree.mockClear()
  mocks.gitWorktreeLand.mockClear()
  mocks.gitWorktreeLand.mockResolvedValue({ ok: true, mode: 'fast-forward' })
  ;(globalThis as unknown as { window: { ion: unknown } }).window.ion = {
    gitWorktreeAppraise: mocks.appraise,
    revealPath: mocks.revealPath,
    gitWorktreeLand: mocks.gitWorktreeLand,
    // Retire asks for its blast radius before offering the confirmation.
    gitWorktreeRetirePreview: vi.fn(async () => ({ prunedBenchPaths: [] })),
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

/**
 * Uniform dismissal: clicking ANY enabled item withdraws the menu at once.
 *
 * Before this was one rule, the seven items had four behaviours: sync and
 * reveal closed immediately; add-to-bench and re-provision closed only after
 * their await resolved, so the menu sat open for the round-trip; land never
 * closed at all on success; and retire waited on the appraisal before its
 * dialog replaced the menu. A menu still on screen after a click reads as a
 * dead click.
 *
 * The opt-out is `keepsMenuOpen`, for items that put their own UI where the
 * menu was (rename's inline editor, land's error dialog, retire's confirm).
 * Those are covered by the withdrawal and retire suites below.
 *
 * Regression direction: drop `if (!item.keepsMenuOpen) onClose()` from the
 * click handler and every test here goes red.
 */
describe('WorktreeRowMenu — uniform dismissal', () => {
  /** The menu is gone from the DOM entirely, not merely withdrawn. */
  function menuGone(): boolean {
    return document.querySelector('[data-testid="worktree-row-menu"]') === null
      && document.querySelector('[data-ion-confirm]') === null
  }

  it('closes immediately on Reveal in Finder', async () => {
    render()
    await press('Reveal in Finder')

    expect(closed).toBe(1)
    expect(menuGone()).toBe(true)
    expect(mocks.revealPath).toHaveBeenCalledWith(WT)
  })

  it('closes immediately on Re-provision, not after the await resolves', async () => {
    // Held open: the menu must be gone BEFORE this settles.
    let finish!: (r: { ok: boolean }) => void
    mocks.reprovisionWorktree.mockImplementation(() => new Promise((res) => { finish = res }))
    render()

    await press('Re-provision')

    expect(closed).toBe(1)
    expect(menuGone()).toBe(true)
    expect(mocks.reprovisionWorktree).toHaveBeenCalledWith(REPO, WT)

    await act(async () => { finish({ ok: true }) })
  })

  it('closes immediately on Add to integration bench', async () => {
    let finish!: (r: { ok: boolean }) => void
    mocks.benchAddMember.mockImplementation(() => new Promise((res) => { finish = res }))
    render()

    await press('Add to integration bench')

    expect(closed).toBe(1)
    expect(menuGone()).toBe(true)

    await act(async () => { finish({ ok: true }) })
  })

  it('closes immediately on Sync', async () => {
    // `isDirty` gates Sync, so use a clean entry for this one.
    renderWith({ isDirty: false, needsSync: true })

    await press('Sync from josh')

    expect(closed).toBe(1)
    expect(menuGone()).toBe(true)
    expect(mocks.syncWorktree).toHaveBeenCalledWith(WT, 'josh', REPO)
  })

  it('closes on a successful Land', async () => {
    mocks.gitWorktreeLand.mockResolvedValue({ ok: true, mode: 'fast-forward' })
    renderWith({ isDirty: false, unlandedCommitCount: 2 })

    await press('Land into josh')

    // Land is `keepsMenuOpen` because a REFUSAL raises a dialog it owns, so the
    // success path has to dismiss explicitly. It previously never did.
    expect(closed).toBe(1)
    expect(menuGone()).toBe(true)
    expect(mocks.sealLandedWorktree).toHaveBeenCalledWith(WT)
  })

  it('keeps the menu mounted when a Land is refused, to show the error', async () => {
    mocks.gitWorktreeLand.mockResolvedValue({ ok: false, error: 'Branch has diverged.' })
    renderWith({ isDirty: false, unlandedCommitCount: 2 })

    await press('Land into josh')

    expect(closed).toBe(0)
    expect(document.body.textContent ?? '').toContain('Branch has diverged.')
  })

  it('does not close on a disabled item', async () => {
    // Default entry is dirty, so Sync is disabled and its click is inert.
    render()

    const sync = [...document.querySelectorAll('button')]
      .find((b) => b.textContent?.startsWith('Sync from'))!
    expect((sync as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      sync.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(closed).toBe(0)
    expect(mocks.syncWorktree).not.toHaveBeenCalled()
  })

  it('keeps the menu open for Rename, which replaces the body inline', async () => {
    render()

    await press('Name this worktree')

    expect(closed).toBe(0)
    expect(document.querySelector('[data-testid="worktree-rename-input"]')).not.toBeNull()
  })

  it('closes exactly once on New conversation here', async () => {
    render()

    await press('New conversation here')

    expect(closed).toBe(1)
    expect(menuGone()).toBe(true)
    expect(mocks.newWorktreeConversation).toHaveBeenCalledWith(WT)
  })

  it('closes exactly once on a stage selection', async () => {
    render()

    await press('Stage: Building')

    expect(closed).toBe(1)
    expect(menuGone()).toBe(true)
    expect(mocks.setWorktreeStage).toHaveBeenCalled()
  })
})
