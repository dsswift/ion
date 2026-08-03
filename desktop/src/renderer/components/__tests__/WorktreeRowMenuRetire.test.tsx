// @vitest-environment jsdom
//
// WorktreeRowMenu — the Retire confirm button must actually retire.
//
// ── The defect ──────────────────────────────────────────────────────────────
// The menu dismissed itself on any `mousedown` outside its own root element.
// The `ConfirmDialog` it raises is a SIBLING of that root, not a descendant, so
// a mousedown on the dialog's "Retire" button read as "outside": the menu called
// onClose(), the parent unmounted the whole subtree, and the dialog was gone
// before `click` could dispatch onConfirm. The IPC was never reached — the
// button was silently inert, with nothing in the log but the preceding appraise.
//
// Regression direction: restore a local click-outside handler that does not
// exempt `[data-ion-confirm]` and `retires through the confirm dialog` goes red
// because retireWorktree is never called.
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
  // Typed against the real wire shape so the mock cannot drift from it, and so
  // an inferred literal type does not make optional fields mandatory at call
  // sites. A faithful appraisal matters here: the menu logs the path/commit
  // counts, so a two-field stand-in makes the component throw in a way
  // production never would.
  appraise: vi.fn<(worktreePath: string, sourceBranch: string) => Promise<WorktreeAppraisalWire>>(),
  revealPath: vi.fn(async () => undefined),
  gitWorktreeLand: vi.fn<(args: unknown) => Promise<{ ok: boolean; error?: string; mode?: string; hasConflicts?: boolean; conflictDirectory?: string }>>(),
  syncWorktree: vi.fn(async () => ({ ok: true })),
  reprovisionWorktree: vi.fn<(repoPath: string, worktreePath: string) => Promise<{ ok: boolean; error?: string }>>(),
  benchAddMember: vi.fn<(...a: unknown[]) => Promise<{ ok: boolean; error?: string }>>(),
  recordConflictAlert: vi.fn(),
}))

// Icons all stub to null -- none of them carry behaviour these tests assert on.
//
// The list must enumerate every icon the menu imports, and must track that
// import as it changes. `vi.mock` replaces the module wholesale and its factory
// result is inspected for named exports, so a missing name is not a partial
// mock: the first unstubbed import throws at render and every test in the file
// fails at once, which reads as a broken component rather than a stale mock.
// A Proxy would sidestep the enumeration but cannot be used -- the factory
// result must be a real module object.
vi.mock('@phosphor-icons/react', () => {
  const stub = (): null => null
  return {
    ArrowLineDown: stub, ArrowsClockwise: stub, Bug: stub, ChatCircle: stub,
    Check: stub, Flask: stub, FolderOpen: stub, Package: stub,
    PencilSimple: stub, Trash: stub,
  }
})

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
  usePreferencesStore: (selector: (s: { worktreeCompletionStrategy: string }) => unknown) =>
    selector({ worktreeCompletionStrategy: 'merge-ff' }),
}))

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: { benchWorkspaces: Map<string, never> }) => unknown) =>
      selector({ benchWorkspaces: new Map<string, never>() }),
    {
      getState: () => ({
        retireWorktree: mocks.retireWorktree,
        syncWorktree: mocks.syncWorktree,
        reprovisionWorktree: mocks.reprovisionWorktree,
        benchAddMember: mocks.benchAddMember,
        recordConflictAlert: mocks.recordConflictAlert,
      }),
    },
  ),
}))

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn(),
}))

import { PopoverLayerProvider } from '../PopoverLayer'
import { WorktreeRowMenu } from '../WorktreeRowMenu'
import { CLEAN_APPRAISAL, DIRTY_APPRAISAL, REPO, WT, entry, press } from './worktree-row-menu-harness'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let closed: number

/**
 * Render the menu the way `WorktreesSection` actually does: it holds the menu in
 * state and renders nothing once `onClose` fires, so closing UNMOUNTS the menu
 * and every dialog it owns.
 *
 * This fidelity is the whole test. A harness that merely counts `onClose` calls
 * and keeps the menu mounted passes even with the bug present, because the
 * dialog survives the spurious close and its click still lands. The unmount is
 * the mechanism that destroyed the click.
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
  // mockResolvedValue, not just mockClear: a `mockResolvedValue` set inside one
  // describe survives mockClear and would leak a clean appraisal into the
  // dirty-worktree tests, quietly changing what they exercise.
  mocks.appraise.mockClear()
  mocks.appraise.mockResolvedValue(DIRTY_APPRAISAL)
  mocks.revealPath.mockClear()
  mocks.syncWorktree.mockClear()
  mocks.reprovisionWorktree.mockClear()
  mocks.reprovisionWorktree.mockResolvedValue({ ok: true })
  mocks.benchAddMember.mockClear()
  mocks.gitWorktreeLand.mockClear()
  mocks.gitWorktreeLand.mockResolvedValue({ ok: true, mode: 'fast-forward' })
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

describe('WorktreeRowMenu — retire', () => {
  it('retires through the confirm dialog', async () => {
    render()

    // Open the appraisal-backed confirmation.
    await press('Retire worktree')
    expect(mocks.appraise).toHaveBeenCalledWith(WT, 'josh')

    // The dialog is up, and it is a sibling of the menu root.
    const dialog = document.querySelector('[data-ion-confirm]')
    expect(dialog).not.toBeNull()

    // THE REGRESSION: pressing Retire must reach the store action. With the bug
    // present the mousedown unmounts the menu and this call never happens.
    await press('Retire')
    expect(mocks.retireWorktree).toHaveBeenCalledWith(REPO, WT, 'wt/ion-a3f1')
  })

  it('does not dismiss the menu when the confirm dialog is pressed', async () => {
    render()
    await press('Retire worktree')

    const before = closed
    const dialog = document.querySelector('[data-ion-confirm]')!
    await act(async () => {
      dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    // A mousedown inside the dialog is NOT an outside click.
    expect(closed).toBe(before)
  })

  it('still dismisses on a genuine outside mousedown', async () => {
    render()

    const before = closed
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(closed).toBe(before + 1)
  })

  it('names the recovery ref so preserved work is findable', async () => {
    mocks.retireWorktree.mockResolvedValue({
      ok: true,
      workingDirectory: '/repo',
      recoveryRef: 'refs/ion/recovery/wt-ion-a3f1-1730000000',
    })
    render()

    await press('Retire worktree')
    await press('Retire')

    const text = document.body.textContent ?? ''
    expect(text).toContain('refs/ion/recovery/wt-ion-a3f1-1730000000')
  })

  it('surfaces a refusal instead of closing as though it worked', async () => {
    mocks.retireWorktree.mockResolvedValue({
      ok: false,
      error: 'Could not preserve the uncommitted work. The worktree was kept so nothing is lost.',
    })
    render()

    await press('Retire worktree')
    await press('Retire')

    expect(document.body.textContent ?? '').toContain('The worktree was kept')
  })
})

/**
 * The clean / landed worktree.
 *
 * Reported defect: right-clicking a worktree in the landed group and clicking
 * "Retire worktree" showed no confirmation at all. The context menu did not even
 * close — it sat open while the retire ran, and the row vanished ~2s later.
 *
 * Cause: `requestRetire` treated the appraisal as the decision. When
 * `safeToDiscard` was true it called `doRetire()` directly and set the confirm
 * message to `null`, so the dialog never rendered. Present since the original
 * feature commit (6e302f31); invisible until now because a DIRTY worktree always
 * took the confirm branch.
 *
 * Regression direction: restore `if (appraisal.safeToDiscard) await doRetire()`
 * and every test here goes red — `retireWorktree` fires with no dialog on screen.
 */
describe('WorktreeRowMenu — retiring a landed worktree', () => {
  it('still confirms when the appraisal says nothing would be lost', async () => {
    mocks.appraise.mockResolvedValue(CLEAN_APPRAISAL)
    render()

    await press('Retire worktree')

    // A destructive action gets a prompt whether or not the work is recoverable.
    expect(document.querySelector('[data-ion-confirm]')).not.toBeNull()
    expect(mocks.retireWorktree).not.toHaveBeenCalled()
  })

  it('says the work has landed rather than leaving the reason blank', async () => {
    mocks.appraise.mockResolvedValue(CLEAN_APPRAISAL)
    render()

    await press('Retire worktree')

    // The appraisal's finding is information the operator wants BEFORE deciding.
    expect(document.body.textContent ?? '').toContain('nothing would be lost')
  })

  it('retires only after the operator confirms', async () => {
    mocks.appraise.mockResolvedValue(CLEAN_APPRAISAL)
    render()

    await press('Retire worktree')
    expect(mocks.retireWorktree).not.toHaveBeenCalled()

    await press('Retire')
    expect(mocks.retireWorktree).toHaveBeenCalledWith(REPO, WT, 'wt/ion-a3f1')
  })

  it('keeps the worktree when the operator declines', async () => {
    mocks.appraise.mockResolvedValue(CLEAN_APPRAISAL)
    render()

    await press('Retire worktree')
    await press('Keep it')

    expect(mocks.retireWorktree).not.toHaveBeenCalled()
    expect(closed).toBe(1)
  })
})

/**
 * The menu must not sit open behind its own confirmation.
 *
 * Second half of the same report: "the context menu didn't even disappear when I
 * clicked the button". A menu still on screen after a click is the operator's
 * signal that the click did nothing.
 */
describe('WorktreeRowMenu — menu withdrawal', () => {
  it('withdraws the menu body once a dialog is up', async () => {
    render()
    expect(document.querySelector('[data-testid="worktree-row-menu"]')).not.toBeNull()

    await press('Retire worktree')

    expect(document.querySelector('[data-testid="worktree-row-menu"]')).toBeNull()
    expect(document.querySelector('[data-ion-confirm]')).not.toBeNull()
  })

  it('withdraws the menu body behind the outcome dialog too', async () => {
    mocks.retireWorktree.mockResolvedValue({
      ok: true, workingDirectory: '/repo', recoveryRef: 'refs/ion/recovery/x-1',
    })
    render()

    await press('Retire worktree')
    await press('Retire')

    expect(document.querySelector('[data-testid="worktree-row-menu"]')).toBeNull()
    expect(document.body.textContent ?? '').toContain('refs/ion/recovery/x-1')
  })

  it('leaves the menu visible when no dialog has been raised', async () => {
    render()

    // The non-destructive verbs do not raise a dialog, so the menu stays put
    // until it closes itself.
    expect(document.querySelector('[data-testid="worktree-row-menu"]')).not.toBeNull()
    expect(document.querySelector('[data-ion-confirm]')).toBeNull()
  })
})

/**
 * The in-flight window.
 *
 * A retire takes seconds — logged evidence from the reported case was
 * `retire: starting` to `retire: done` at just under four. For that whole window
 * the confirm dialog used to render a live Retire button, a live "Keep it", a
 * live backdrop, and a live Escape, with nothing on screen to say anything was
 * happening. Pressing Retire looked like pressing a dead button, and Escape
 * unmounted the menu (and the outcome dialog with it) mid-operation, discarding
 * a recovery ref that exists nowhere else.
 *
 * These tests hold `retireWorktree` open on a deferred promise so the in-flight
 * state can be asserted directly instead of raced.
 */
describe('WorktreeRowMenu — retire in flight', () => {
  /** Resolver for the pending `retireWorktree`, installed by `startRetire`. */
  let settle: (r: { ok: boolean; workingDirectory?: string; recoveryRef?: string; error?: string }) => void

  async function startRetire(): Promise<void> {
    mocks.retireWorktree.mockImplementation(() => new Promise((resolve) => { settle = resolve }))
    render()
    await press('Retire worktree')
    await press('Retire')
    expect(mocks.retireWorktree).toHaveBeenCalledTimes(1)
  }

  it('says what it is doing instead of looking inert', async () => {
    await startRetire()

    expect(document.querySelector('[data-testid="confirm-dialog-busy"]')).not.toBeNull()
    expect(document.body.textContent ?? '').toContain('Retiring the worktree…')

    await act(async () => { settle({ ok: true, workingDirectory: '/repo' }) })
  })

  it('does not run a second retire when the button is pressed again', async () => {
    await startRetire()

    // The dialog is still mounted and the button still labelled "Retire" — the
    // disabled attribute is what has to stop this, not the dialog disappearing.
    await press('Retire')
    expect(mocks.retireWorktree).toHaveBeenCalledTimes(1)

    await act(async () => { settle({ ok: true, workingDirectory: '/repo' }) })
  })

  it('does not cancel out from under the running operation', async () => {
    await startRetire()

    await press('Keep it')

    // Still mounted, still busy: cancelling would not stop the git operation,
    // only hide it.
    expect(closed).toBe(0)
    expect(document.querySelector('[data-testid="confirm-dialog-busy"]')).not.toBeNull()

    await act(async () => { settle({ ok: true, workingDirectory: '/repo' }) })
  })

  it('does not unmount the menu on Escape mid-retire', async () => {
    await startRetire()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    // THE REGRESSION: the menu's own `useOutsideDismiss` Escape handler is a
    // separate window listener from the dialog's, and `onClose` unmounts the
    // menu AND the dialog with it. Drop the `busy` guard on `dismiss` and this
    // goes red.
    //
    // Asserted via `closed` and the surviving dialog rather than the menu body:
    // the body is deliberately withdrawn while a dialog is up (a menu sitting
    // open behind its own confirmation reads as a dead click), so its absence
    // here is correct. What must NOT happen is the component unmounting, which
    // would take the in-flight dialog and its outcome with it.
    expect(closed).toBe(0)
    expect(document.querySelector('[data-ion-confirm]')).not.toBeNull()
    expect(document.querySelector('[data-testid="confirm-dialog-busy"]')).not.toBeNull()

    await act(async () => { settle({ ok: true, workingDirectory: '/repo' }) })
  })

  it('still dismisses on Escape once the operation is done', async () => {
    await startRetire()
    // Resolve clean: the clean path closes the menu itself, so use a refusal to
    // leave the menu mounted with `busy` back to false.
    await act(async () => {
      settle({ ok: false, error: 'Could not preserve the uncommitted work.' })
    })

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(closed).toBe(1)
  })

  it('hands the outcome one button, not two for one choice', async () => {
    await startRetire()
    await act(async () => {
      settle({ ok: true, workingDirectory: '/repo', recoveryRef: 'refs/ion/recovery/wt-ion-a3f1-1730000000' })
    })

    // The busy row is gone and the outcome is up.
    expect(document.querySelector('[data-testid="confirm-dialog-busy"]')).toBeNull()
    expect(document.body.textContent ?? '').toContain('refs/ion/recovery/wt-ion-a3f1-1730000000')

    // One outcome, one button. The old shape rendered "OK" and "Dismiss" wired
    // to the identical handler.
    const dialogButtons = [...document.querySelectorAll('[data-ion-confirm] button')]
    expect(dialogButtons).toHaveLength(1)
    expect(dialogButtons[0].textContent?.trim()).toBe('OK')
  })
})
