// @vitest-environment jsdom
//
// WorktreePipelinePanel — state-driven rendering of the sync-all pipeline.
//
// What each test pins and the regression it catches:
//
//   - hidden-when-idle: the panel renders nothing when there are no actionable
//     entries and no pipeline state, so the git panel stays clean.
//   - actionable-verb: the "Sync all" button appears with a count badge when at
//     least one worktree has `needsSync` or `operationState` set.
//   - busy-disables-verb: when a pipeline is running for a DIFFERENT repo, the
//     button is present but disabled (opacity 0.5) so the operator sees why
//     "Sync all" does nothing.
//   - phase-labels: every pipeline phase renders its expected one-liner in the
//     banner, including the resolving phase's progress fraction and the current
//     worktree name.
//   - ai-confirm-dialog: the awaiting-ai-confirm phase renders a ConfirmDialog
//     listing the conflicted worktree names in its message body.
//   - cancel-button: the cancel button is present during running phases and
//     absent during terminal phases (done/failed).
//   - terminal-dismiss: the dismiss (X) button appears only on terminal phases
//     and is absent while the pipeline is still running.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@phosphor-icons/react', () => ({
  ArrowsClockwise: () => null,
  CheckCircle: () => null,
  CircleNotch: () => null,
  Warning: () => null,
  X: (props: { size?: number }) => React.createElement('span', { 'data-icon': 'x', style: { fontSize: props.size } }),
}))

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }),
}))

vi.mock('../git/Tooltip', () => ({
  Tooltip: ({ text, children }: { text: string; children: React.ReactNode }) =>
    React.createElement('span', { 'data-tooltip': text }, children),
}))

const mockConfirmProps: Array<{ title: string; message: string }> = []
vi.mock('../git/ConfirmDialog', () => ({
  ConfirmDialog: (props: { title: string; message: string; onConfirm: () => void; onCancel: () => void }) => {
    mockConfirmProps.push({ title: props.title, message: props.message })
    return React.createElement('div', { 'data-testid': 'confirm-dialog', 'data-title': props.title },
      React.createElement('button', { 'data-testid': 'confirm-yes', onClick: props.onConfirm }),
      React.createElement('button', { 'data-testid': 'confirm-cancel', onClick: props.onCancel }),
    )
  },
}))

vi.mock('../../rendererLogger', () => ({
  rError: vi.fn(),
}))

import type { WorktreePipelineState } from '../../stores/session-store-types'
import type { WorktreeInventoryEntry } from '../../../shared/types'

const startPipeline = vi.fn().mockResolvedValue(undefined)
const cancelPipeline = vi.fn()
const dismissPipeline = vi.fn()
const confirmAi = vi.fn().mockResolvedValue(undefined)

let pipelineState: WorktreePipelineState | null = null

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel({ worktreePipeline: pipelineState }),
    {
      getState: () => ({
        startWorktreePipeline: startPipeline,
        cancelWorktreePipeline: cancelPipeline,
        dismissWorktreePipeline: dismissPipeline,
        confirmWorktreePipelineAi: confirmAi,
      }),
    },
  ),
}))

import { WorktreePipelinePanel } from '../WorktreePipelinePanel'

const REPO = '/Users/dev/proj'

function entry(over: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  return {
    worktreePath: '/wt/a',
    branchName: 'wt/a',
    label: 'a',
    sourceBranch: 'main',
    head: 'abc',
    lastCommitSubject: 'init',
    isDirty: false,
    unlandedCommitCount: 0,
    needsSync: false,
    safeToDiscard: false,
    ...over,
  }
}

function pipeline(over: Partial<WorktreePipelineState> = {}): WorktreePipelineState {
  return {
    repoPath: REPO,
    sourceBranch: 'main',
    phase: 'syncing',
    outcomes: [],
    queue: [],
    current: null,
    needsManual: [],
    resolvedByAi: 0,
    cancelled: false,
    startedAt: Date.now(),
    ...over,
  }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

function render(
  entries: WorktreeInventoryEntry[],
  sourceBranch: string | null = 'main',
): void {
  act(() => {
    root.render(
      <WorktreePipelinePanel
        repoPath={REPO}
        sourceBranch={sourceBranch}
        entries={entries}
      />,
    )
  })
}

const q = (testid: string): HTMLElement | null => host.querySelector(`[data-testid="${testid}"]`)

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  pipelineState = null
  mockConfirmProps.length = 0
  startPipeline.mockClear()
  cancelPipeline.mockClear()
  dismissPipeline.mockClear()
  confirmAi.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('WorktreePipelinePanel', () => {
  it('renders nothing when idle with no actionable entries', () => {
    render([entry()])
    expect(host.innerHTML).toBe('')
  })

  it('shows "Sync all" verb with count when entries are actionable', () => {
    render([
      entry({ needsSync: true }),
      entry({ worktreePath: '/wt/b', branchName: 'wt/b', operationState: { type: 'rebase-conflict' } as never }),
      entry({ worktreePath: '/wt/c' }),
    ])
    const btn = q('worktree-sync-all') as HTMLButtonElement | null
    expect(btn).not.toBeNull()
    expect(btn!.textContent).toContain('2')
    expect(btn!.disabled).toBe(false)
  })

  it('disables verb when a different repo pipeline is busy', () => {
    pipelineState = pipeline({ repoPath: '/other/repo', phase: 'syncing' })
    render([entry({ needsSync: true })])
    const btn = q('worktree-sync-all') as HTMLButtonElement | null
    expect(btn).not.toBeNull()
    expect(btn!.disabled).toBe(true)
    expect(btn!.style.opacity).toBe('0.5')
  })

  describe('phase labels', () => {
    it('syncing', () => {
      pipelineState = pipeline({ phase: 'syncing' })
      render([])
      const banner = q('worktree-pipeline-banner')
      expect(banner!.textContent).toContain('Syncing worktrees from source')
    })

    it('awaiting-ai-confirm', () => {
      pipelineState = pipeline({ phase: 'awaiting-ai-confirm', queue: ['/wt/a'] })
      render([])
      const banner = q('worktree-pipeline-banner')
      expect(banner!.textContent).toContain('Waiting for confirmation')
    })

    it('resolving with current worktree', () => {
      pipelineState = pipeline({
        phase: 'resolving',
        queue: ['/wt/b'],
        current: '/wt/a',
        resolvedByAi: 0,
        needsManual: [],
        outcomes: [{ worktreePath: '/wt/a', title: 'Feature A' } as never],
      })
      render([])
      const banner = q('worktree-pipeline-banner')
      expect(banner!.textContent).toContain('Resolving Feature A')
      expect(banner!.textContent).toMatch(/\d+\/\d+/)
    })

    it('assembling', () => {
      pipelineState = pipeline({ phase: 'assembling' })
      render([])
      expect(q('worktree-pipeline-banner')!.textContent).toContain('Updating bench')
    })

    it('done with summary', () => {
      pipelineState = pipeline({ phase: 'done', summary: '3 synced, 1 skipped (dirty)' })
      render([])
      expect(q('worktree-pipeline-banner')!.textContent).toContain('3 synced, 1 skipped (dirty)')
    })

    it('failed with summary', () => {
      pipelineState = pipeline({ phase: 'failed', summary: 'Network error' })
      render([])
      expect(q('worktree-pipeline-banner')!.textContent).toContain('Network error')
    })
  })

  describe('AI confirm dialog', () => {
    it('renders ConfirmDialog listing conflicted worktrees', () => {
      pipelineState = pipeline({
        phase: 'awaiting-ai-confirm',
        queue: ['/wt/alpha', '/wt/beta'],
        outcomes: [
          { worktreePath: '/wt/alpha', title: 'Alpha Feature' } as never,
          { worktreePath: '/wt/beta', branchName: 'wt/beta' } as never,
        ],
      })
      render([])
      expect(q('confirm-dialog')).not.toBeNull()
      expect(mockConfirmProps).toHaveLength(1)
      expect(mockConfirmProps[0].title).toContain('2 conflicts')
      expect(mockConfirmProps[0].message).toContain('Alpha Feature')
    })

    it('confirm calls confirmWorktreePipelineAi', () => {
      pipelineState = pipeline({
        phase: 'awaiting-ai-confirm',
        queue: ['/wt/a'],
        outcomes: [{ worktreePath: '/wt/a', title: 'A' } as never],
      })
      render([])
      act(() => q('confirm-yes')!.click())
      expect(confirmAi).toHaveBeenCalled()
    })

    it('cancel calls cancelWorktreePipeline', () => {
      pipelineState = pipeline({
        phase: 'awaiting-ai-confirm',
        queue: ['/wt/a'],
        outcomes: [{ worktreePath: '/wt/a', title: 'A' } as never],
      })
      render([])
      act(() => q('confirm-cancel')!.click())
      expect(cancelPipeline).toHaveBeenCalled()
    })
  })

  describe('cancel button', () => {
    it('present during syncing phase', () => {
      pipelineState = pipeline({ phase: 'syncing' })
      render([])
      expect(q('worktree-pipeline-cancel')).not.toBeNull()
    })

    it('present during resolving phase', () => {
      pipelineState = pipeline({ phase: 'resolving' })
      render([])
      expect(q('worktree-pipeline-cancel')).not.toBeNull()
    })

    it('absent during awaiting-ai-confirm (confirm dialog replaces it)', () => {
      pipelineState = pipeline({
        phase: 'awaiting-ai-confirm',
        queue: ['/wt/a'],
        outcomes: [{ worktreePath: '/wt/a', title: 'A' } as never],
      })
      render([])
      expect(q('worktree-pipeline-cancel')).toBeNull()
    })

    it('absent on terminal done', () => {
      pipelineState = pipeline({ phase: 'done' })
      render([])
      expect(q('worktree-pipeline-cancel')).toBeNull()
    })

    it('shows "Stopping…" when cancelled', () => {
      pipelineState = pipeline({ phase: 'syncing', cancelled: true })
      render([])
      const btn = q('worktree-pipeline-cancel') as HTMLButtonElement
      expect(btn.textContent).toBe('Stopping…')
      expect(btn.disabled).toBe(true)
    })
  })

  describe('terminal dismissal', () => {
    it('dismiss button present when done', () => {
      pipelineState = pipeline({ phase: 'done', summary: 'All synced' })
      render([])
      expect(q('worktree-pipeline-dismiss')).not.toBeNull()
    })

    it('dismiss button present when failed', () => {
      pipelineState = pipeline({ phase: 'failed', summary: 'Error' })
      render([])
      expect(q('worktree-pipeline-dismiss')).not.toBeNull()
    })

    it('dismiss button absent while running', () => {
      pipelineState = pipeline({ phase: 'resolving' })
      render([])
      expect(q('worktree-pipeline-dismiss')).toBeNull()
    })

    it('clicking dismiss calls dismissWorktreePipeline', () => {
      pipelineState = pipeline({ phase: 'done' })
      render([])
      act(() => q('worktree-pipeline-dismiss')!.click())
      expect(dismissPipeline).toHaveBeenCalled()
    })
  })
})
