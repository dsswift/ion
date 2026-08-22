// @vitest-environment jsdom
//
// BenchConflictDialog — the bench conflict's own surface.
//
// The defect that motivated this dialog: a bench conflict has NO in-progress
// git operation (the failed assembly aborts its merge and wipes the bench), so
// routing the badge to the operation-state ConflictsDialog produced an empty
// file list and a dead Abort. This dialog reads the membership RECORD — the
// only place the conflict evidence lives — so these tests pin that the record
// is what renders, and that the two verbs route to the right store actions.
import React from 'react'
import { act } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../theme', () => ({
  useColors: () => new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }),
}))
// FloatingPanel portals through the popover layer; a plain container keeps the
// dialog's content queryable without the layer machinery.
vi.mock('../../FloatingPanel', () => ({
  FloatingPanel: ({ title, children }: { title: string; children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'panel', 'data-title': title }, children),
}))
vi.mock('../../../rendererLogger', () => ({
  rError: vi.fn(), rWarn: vi.fn(), rInfo: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn(),
}))

const benchResolveConflict = vi.fn(async (): Promise<string | null> => null)
const openWorktreeConversation = vi.fn(async () => 'tab-1')

vi.mock('../../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ benchResolveConflict, openWorktreeConversation }),
    { getState: () => ({ benchResolveConflict, openWorktreeConversation }) },
  ),
}))

import { BenchConflictDialog } from '../BenchConflictDialog'
import type { IntegrationMember } from '../../../../shared/types'

function conflictedMember(over: Partial<IntegrationMember> = {}): IntegrationMember {
  return {
    worktreePath: '/wt/a',
    branchName: 'wt/a',
        pin: 'current',
    merge: 'conflicted',
    pinnedSha: 'abc1234',
    pinnedTreeHash: 't1',
    pinnedBaseSha: 'b1',
    currentTreeHash: 't1',
    conflictPaths: ['desktop/src/shared/types.ts', 'engine/internal/a.go'],
    conflictsWith: ['wt/b'],
    ...over,
  }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const onClose = vi.fn()
const onResolveReady = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(member: IntegrationMember): void {
  act(() => {
    root.render(React.createElement(BenchConflictDialog, {
      repoPath: '/repo',
      sourceBranch: 'josh',
      member,
      onClose,
      onResolveReady,
    }))
  })
}

const q = (testid: string): HTMLElement | null => host.querySelector(`[data-testid="${testid}"]`)

/** Let the pending store-action promise chain settle inside act(). */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

describe('BenchConflictDialog — renders the membership record', () => {
  it('lists every conflicting path from the record', () => {
    render(conflictedMember())

    expect(q('bench-conflict-path-desktop/src/shared/types.ts')).not.toBeNull()
    expect(q('bench-conflict-path-engine/internal/a.go')).not.toBeNull()
  })

  it('names the colliding members', () => {
    render(conflictedMember())
    expect(host.textContent).toContain('wt/b')
  })

  it('attributes the collision to the base branch when no member collides', () => {
    // conflictsWith empty is a real shape: the member collides with the
    // SOURCE BRANCH itself, not with another member's contribution.
    render(conflictedMember({ conflictsWith: [] }))
    expect(host.textContent).toContain('base branch (josh)')
  })

  it('explains the atomic wipe: the bench is empty until resolved', () => {
    render(conflictedMember())
    expect(host.textContent).toMatch(/left empty/i)
  })
})

describe('BenchConflictDialog — the two verbs', () => {
  it('Resolve once prepares the merge and hands the bench path to onResolveReady', async () => {
    benchResolveConflict.mockResolvedValueOnce('/bench/josh')
    render(conflictedMember())

    act(() => { q('bench-conflict-resolve')!.click() })
    await settle()

    expect(benchResolveConflict).toHaveBeenCalledWith('/repo', 'josh')
    expect(onResolveReady).toHaveBeenCalledWith('/bench/josh')
  })

  it('Resolve once closes without a resolver when nothing is left to resolve', async () => {
    // Recordings already covered the conflict: the store reassembled and
    // returned null. Opening a resolver over a clean bench would recreate the
    // exact empty-dialog defect this component replaced.
    benchResolveConflict.mockResolvedValueOnce(null)
    render(conflictedMember())

    act(() => { q('bench-conflict-resolve')!.click() })
    await settle()

    expect(onResolveReady).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('Open worktree routes to the member worktree that owns the fix', async () => {
    render(conflictedMember())

    act(() => { q('bench-conflict-open-worktree')!.click() })
    await settle()

    expect(openWorktreeConversation).toHaveBeenCalledWith('/wt/a')
    expect(onClose).toHaveBeenCalled()
  })
})
