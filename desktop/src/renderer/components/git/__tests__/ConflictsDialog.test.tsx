// @vitest-environment jsdom
//
// ConflictsDialog — the resolution list.
//
// What is pinned: rows render from GIT_OP_STATE, the Accept buttons call the
// accept IPC with the right side, Merge opens the 3-way editor, Continue stays
// disabled while conflicts remain and enables when the list empties, and AI
// Assisted routes through the one forwarded store action with the directory.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))
vi.mock('../../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))
// FloatingPanel drags in PopoverLayer/preferences/session plumbing that is
// irrelevant here; render children in a plain div.
vi.mock('../../FloatingPanel', () => ({
  FloatingPanel: ({ title, children }: { title: string; children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'panel', 'data-title': title }, children),
}))
// The MergeEditor has its own tests; here only "Merge… opens it" matters.
vi.mock('../MergeEditor', () => ({
  MergeEditor: ({ path }: { path: string }) =>
    React.createElement('div', { 'data-testid': `merge-editor-${path}` }),
}))
vi.mock('../ConfirmDialog', () => ({
  ConfirmDialog: ({ onConfirm }: { onConfirm: () => void }) =>
    React.createElement('button', { 'data-testid': 'confirm-abort', onClick: onConfirm }),
}))

const openConflictAssist = vi.fn().mockResolvedValue('tab-1')
const clearConflictAlert = vi.fn()
vi.mock('../../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ openConflictAssist, clearConflictAlert }) },
}))

import { ConflictsDialog } from '../ConflictsDialog'

const DIR = '/wt/proj-a1'

function opState(files: Array<{ path: string; shape: string }>): Record<string, unknown> {
  return {
    ok: true,
    state: 'rebasing',
    branch: 'wt/proj-a1',
    onto: 'abc1234',
    oursLabel: 'base (abc1234)',
    theirsLabel: 'wt/proj-a1',
    files: files.map((f) => ({ ...f, hasBase: true, hasOurs: true, hasTheirs: true })),
  }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const gitOpState = vi.fn()
const gitConflictAccept = vi.fn()
const gitRebaseAbort = vi.fn()
const gitRebaseContinue = vi.fn()

async function render(onClose = (): void => {}): Promise<void> {
  await act(async () => {
    root.render(React.createElement(ConflictsDialog, { directory: DIR, onClose }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { ion: Record<string, unknown> }).ion = {
    gitOpState, gitConflictAccept, gitRebaseAbort, gitRebaseContinue,
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('ConflictsDialog', () => {

  it('shows loading state until operation state returns, then renders its conflicted file', async () => {
    let resolveState!: (value: Record<string, unknown>) => void
    gitOpState.mockReturnValue(new Promise<Record<string, unknown>>((resolve) => { resolveState = resolve }))
    await render()
    expect(host.querySelector('[data-testid="conflict-state-loading"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="conflict-row-engine/internal/backend/runloop.go"]')).toBeNull()

    await act(async () => { resolveState(opState([{ path: 'engine/internal/backend/runloop.go', shape: 'both modified' }])) })
    expect(host.querySelector('[data-testid="conflict-state-loading"]')).toBeNull()
    expect(host.querySelector('[data-testid="conflict-row-engine/internal/backend/runloop.go"]')).not.toBeNull()
  })

  it('renders one row per conflicted file with its shape', async () => {
    gitOpState.mockResolvedValue(opState([
      { path: 'shared.txt', shape: 'both modified' },
      { path: 'new.txt', shape: 'both added' },
    ]))
    await render()

    expect(host.querySelector('[data-testid="conflict-row-shared.txt"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="conflict-row-new.txt"]')).not.toBeNull()
    expect(host.textContent).toContain('both modified')
    expect(host.textContent).toContain('both added')
    // The side legend names branches, never bare ours/theirs.
    expect(host.textContent).toContain('base (abc1234)')
    expect(host.textContent).toContain('wt/proj-a1')
  })

  it('Accept yours / theirs call the accept IPC with the right side', async () => {
    gitOpState.mockResolvedValue(opState([{ path: 'shared.txt', shape: 'both modified' }]))
    gitConflictAccept.mockResolvedValue({ ok: true })
    await render()

    await act(async () => {
      (host.querySelector('[data-testid="conflict-accept-ours-shared.txt"]') as HTMLButtonElement).click()
    })
    expect(gitConflictAccept).toHaveBeenCalledWith(DIR, 'shared.txt', 'ours')

    await act(async () => {
      (host.querySelector('[data-testid="conflict-accept-theirs-shared.txt"]') as HTMLButtonElement).click()
    })
    expect(gitConflictAccept).toHaveBeenCalledWith(DIR, 'shared.txt', 'theirs')
  })

  it('Merge… opens the 3-way editor for that file', async () => {
    gitOpState.mockResolvedValue(opState([{ path: 'shared.txt', shape: 'both modified' }]))
    await render()

    await act(async () => {
      (host.querySelector('[data-testid="conflict-merge-shared.txt"]') as HTMLButtonElement).click()
    })
    expect(host.querySelector('[data-testid="merge-editor-shared.txt"]')).not.toBeNull()
  })

  it('Continue is disabled while conflicts remain and enabled when resolved', async () => {
    gitOpState.mockResolvedValue(opState([{ path: 'shared.txt', shape: 'both modified' }]))
    await render()
    expect((host.querySelector('[data-testid="conflict-continue"]') as HTMLButtonElement).disabled).toBe(true)

    // The list empties (all resolved) but the operation is still in progress.
    gitOpState.mockResolvedValue(opState([]))
    gitConflictAccept.mockResolvedValue({ ok: true })
    await act(async () => {
      (host.querySelector('[data-testid="conflict-accept-ours-shared.txt"]') as HTMLButtonElement).click()
    })
    expect((host.querySelector('[data-testid="conflict-continue"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('a failed Continue re-probes op state instead of leaving the stale "all resolved" banner up', async () => {
    // A multi-commit rebase step that already cleared: the dialog opens
    // showing zero conflicted files and an enabled Continue.
    gitOpState.mockResolvedValueOnce(opState([]))
    await render()
    expect(host.textContent).toContain('All conflicts are resolved')
    expect((host.querySelector('[data-testid="conflict-continue"]') as HTMLButtonElement).disabled).toBe(false)

    // Continue commits that step, then git walks forward and stops on a
    // BRAND NEW conflict further down the rebase todo.
    gitRebaseContinue.mockResolvedValue({ ok: false, error: 'could not apply 7c1940505...' })
    gitOpState.mockResolvedValueOnce(opState([{ path: 'WorktreeRowMenu.tsx', shape: 'both modified' }]))

    await act(async () => {
      (host.querySelector('[data-testid="conflict-continue"]') as HTMLButtonElement).click()
    })

    expect(gitRebaseContinue).toHaveBeenCalledWith(DIR)
    // The failure message stays up...
    expect(host.textContent).toContain('could not apply 7c1940505')
    // ...and the dialog shows the REAL current conflict, not the stale empty
    // list from the step that just finished.
    expect(host.querySelector('[data-testid="conflict-row-WorktreeRowMenu.tsx"]')).not.toBeNull()
    expect(host.textContent).not.toContain('All conflicts are resolved')
    expect((host.querySelector('[data-testid="conflict-continue"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('AI Assisted routes through the forwarded store action and closes', async () => {
    gitOpState.mockResolvedValue(opState([{ path: 'shared.txt', shape: 'both modified' }]))
    const onClose = vi.fn()
    await render(onClose)

    await act(async () => {
      (host.querySelector('[data-testid="conflict-ai-assist"]') as HTMLButtonElement).click()
    })
    expect(openConflictAssist).toHaveBeenCalledWith(DIR)
    expect(onClose).toHaveBeenCalled()
  })

  it('Abort confirms, runs the abort IPC, and clears the alert', async () => {
    gitOpState.mockResolvedValue(opState([{ path: 'shared.txt', shape: 'both modified' }]))
    gitRebaseAbort.mockResolvedValue({ ok: true })
    const onClose = vi.fn()
    await render(onClose)

    await act(async () => {
      (host.querySelector('[data-testid="conflict-abort"]') as HTMLButtonElement).click()
    })
    await act(async () => {
      (host.querySelector('[data-testid="confirm-abort"]') as HTMLButtonElement).click()
    })

    expect(gitRebaseAbort).toHaveBeenCalledWith(DIR)
    expect(clearConflictAlert).toHaveBeenCalledWith(DIR)
    expect(onClose).toHaveBeenCalled()
  })
})
