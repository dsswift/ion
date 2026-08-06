// @vitest-environment jsdom
//
// WorktreeRowMenu — a worktree with ACTIVE work is never offered the retire
// confirmation.
//
// Split from WorktreeRowMenuRetire.test.tsx (file-size cap). That file covers the
// appraisal-backed confirmation and the retire outcome dialogs; this one covers
// the gate that runs BEFORE either of them.
//
// ── Why the gate exists ─────────────────────────────────────────────────────
// A retire deletes the worktree directory, so every conversation living there is
// closed by it — and `closeTab` refuses a conversation that is running, has
// dispatched background agents, or has outstanding background commands (there is
// no `force`, on purpose: forcing would SIGTERM those agents). Offering the
// Retire button in that state would be offering an action that must refuse, so
// the menu answers with the acknowledge-only error instead and NAMES the
// conversations — deciding whether to interrupt them is the operator's call, and
// Ion must never delete a directory with live work in it.
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
  gitWorktreeLand: vi.fn<(args: unknown) => Promise<{ ok: boolean; error?: string; mode?: string }>>(),
  retirePreview: vi.fn<(worktreePath: string) => Promise<{ prunedBenchPaths: string[] }>>(),
  syncWorktree: vi.fn(async () => ({ ok: true })),
  reprovisionWorktree: vi.fn<(repoPath: string, worktreePath: string) => Promise<{ ok: boolean; error?: string }>>(),
  benchAddMember: vi.fn<(...a: unknown[]) => Promise<{ ok: boolean; error?: string }>>(),
  recordConflictAlert: vi.fn(),
  // Store state the retire pre-flight reads. Mutable per test so a case can put
  // an ACTIVE conversation in the worktree and assert the confirmation is never
  // offered.
  storeTabs: [] as unknown[],
  storePanes: new Map<string, unknown>(),
}))

// Every icon the menu renders must be stubbed. A missing name is not a partial
// mock — vi.mock replaces the module wholesale, so the first unstubbed import
// throws at render and every test in the file fails at once.
vi.mock('@phosphor-icons/react', () => ({
  ArrowLineDown: () => null, ArrowsClockwise: () => null, Bug: () => null,
  ChatCircle: () => null, Check: () => null, Flask: () => null,
  FolderOpen: () => null, Package: () => null, PencilSimple: () => null, Trash: () => null,
}))

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
    {
      // Read by viewport-zoom.ts's zoomViewport(), called on the popover
      // positioning path this menu uses. Without getState the menu throws
      // during render and every test in this file fails at once.
      getState: () => ({ uiZoom: 1 }),
    },
  ),
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
        // Read by resolveRetireBlockers to answer "is anything in this worktree
        // still working".
        tabs: mocks.storeTabs,
        conversationPanes: mocks.storePanes,
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

/**
 * Render the menu the way `WorktreesSection` does: it holds the menu in state and
 * renders nothing once `onClose` fires, so closing UNMOUNTS the menu and every
 * dialog it owns.
 */
function Harness({ over }: { over: Partial<WorktreeInventoryEntry> }): React.JSX.Element | null {
  const [open, setOpen] = React.useState(true)
  if (!open) return null
  return (
    <WorktreeRowMenu
      entry={entry(over)}
      anchor={{ x: 10, y: 10 }}
      repoPath={REPO}
      onClose={() => setOpen(false)}
      onRefresh={() => {}}
    />
  )
}

function render(): void {
  act(() => {
    root.render(
      <PopoverLayerProvider>
        <Harness over={{}} />
      </PopoverLayerProvider>,
    )
  })
}

beforeEach(() => {
  mocks.retireWorktree.mockClear()
  mocks.retireWorktree.mockResolvedValue({ ok: true, workingDirectory: '/repo' })
  mocks.appraise.mockClear()
  mocks.appraise.mockResolvedValue(DIRTY_APPRAISAL)
  mocks.retirePreview.mockClear()
  mocks.retirePreview.mockResolvedValue({ prunedBenchPaths: [] })
  mocks.storeTabs = []
  mocks.storePanes = new Map()
  ;(globalThis as unknown as { window: { ion: unknown } }).window.ion = {
    gitWorktreeAppraise: mocks.appraise,
    revealPath: mocks.revealPath,
    gitWorktreeLand: mocks.gitWorktreeLand,
    gitWorktreeRetirePreview: mocks.retirePreview,
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('WorktreeRowMenu — retire with active work in the worktree', () => {
  /** A conversation tab in the worktree whose pane says it is still running. */
  function installRunningTab(over: Record<string, unknown> = {}): void {
    mocks.storeTabs = [{
      id: 'tab-busy',
      title: 'New Tab',
      customTitle: 'Token expiry fix',
      workingDirectory: WT,
      ...over,
    }]
    mocks.storePanes = new Map([['tab-busy', {
      instances: [{ id: 'main', statusFields: { state: 'running' }, agentStates: [] }],
    }]])
  }

  it('never raises the confirmation while a conversation is running', async () => {
    installRunningTab()
    render()

    await press('Retire worktree')

    // No confirm dialog, and the appraisal is not even asked for: the answer
    // does not depend on what git holds.
    expect(document.querySelector('[data-ion-confirm]')).not.toBeNull()
    expect(document.body.textContent ?? '').toContain('still has active work')
    expect(mocks.retireWorktree).not.toHaveBeenCalled()
  })

  it('names the active conversation so the operator can find it', async () => {
    installRunningTab()
    render()

    await press('Retire worktree')

    const text = document.body.textContent ?? ''
    expect(text).toContain('Token expiry fix')
    expect(text).toContain('running')
  })

  it('offers no Retire button to press at all', async () => {
    installRunningTab()
    render()
    await press('Retire worktree')

    // The outcome dialog is acknowledge-only: one OK button, no confirm verb.
    const labels = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels).not.toContain('Retire')
  })

  it('blocks on a conversation in a SUBDIRECTORY of the worktree', async () => {
    // The retire removes the whole tree, so a tab one level down is just as
    // exposed as one at the root.
    installRunningTab({ workingDirectory: `${WT}/desktop` })
    render()

    await press('Retire worktree')

    expect(document.body.textContent ?? '').toContain('still has active work')
    expect(mocks.retireWorktree).not.toHaveBeenCalled()
  })

  it('ignores a running conversation in a SIBLING worktree', async () => {
    // `${WT}0` is the prefix-extension trap: a bare startsWith would treat this
    // unrelated worktree as an occupant and refuse a retire that is fine.
    installRunningTab({ workingDirectory: `${WT}0` })
    render()

    await press('Retire worktree')

    expect(document.querySelector('[data-ion-confirm]')).not.toBeNull()
    expect(document.body.textContent ?? '').not.toContain('still has active work')
    // The normal appraisal-backed confirmation is what came up.
    expect(mocks.appraise).toHaveBeenCalledWith(WT, 'josh')
  })

  it('blocks on a running conversation in a bench this retire would prune', async () => {
    const BENCH = '/Users/dev/.ion/integration/ion-josh'
    mocks.retirePreview.mockResolvedValue({ prunedBenchPaths: [BENCH] })
    installRunningTab({ workingDirectory: BENCH, customTitle: 'Bench · josh' })
    render()

    await press('Retire worktree')

    expect(document.body.textContent ?? '').toContain('Bench · josh')
    expect(mocks.retireWorktree).not.toHaveBeenCalled()
  })

  it('lets an IDLE conversation in the worktree through', async () => {
    mocks.storeTabs = [{
      id: 'tab-idle', title: 'New Tab', customTitle: null, workingDirectory: WT,
    }]
    mocks.storePanes = new Map([['tab-idle', {
      instances: [{ id: 'main', statusFields: { state: 'idle' }, agentStates: [] }],
    }]])
    render()

    await press('Retire worktree')

    expect(document.body.textContent ?? '').not.toContain('still has active work')
    await press('Retire')
    expect(mocks.retireWorktree).toHaveBeenCalledWith(REPO, WT, 'wt/ion-a3f1')
  })

  it('lets a TERMINAL in the worktree through — a shell is not active work', async () => {
    // A terminal has no conversation pane, so it has no orchestrator and no
    // dispatched agents to protect. It is closed by the retire, not waited on.
    mocks.storeTabs = [{
      id: 'tab-term', title: 'Terminal', customTitle: null, workingDirectory: WT, isTerminalOnly: true,
    }]
    mocks.storePanes = new Map()
    render()

    await press('Retire worktree')
    await press('Retire')

    expect(mocks.retireWorktree).toHaveBeenCalledWith(REPO, WT, 'wt/ion-a3f1')
  })

  // The store action is the enforcement point for the ATV path and for the
  // check-to-retire race, and its refusal must reach the operator too.
  it('surfaces a refusal that came from the store action', async () => {
    mocks.retireWorktree.mockResolvedValue({
      ok: false,
      error: 'This worktree still has active work, so it was not retired.\n• Migration sweep — running',
    })
    render()

    await press('Retire worktree')
    await press('Retire')

    const text = document.body.textContent ?? ''
    expect(text).toContain('still has active work')
    expect(text).toContain('Migration sweep')
  })
})

/**
 * The menu must not sit open behind its own confirmation.
 *
 * Second half of the same report: "the context menu didn't even disappear when I
 * clicked the button". A menu still on screen after a click is the operator's
 * signal that the click did nothing.
 */
