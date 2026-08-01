// @vitest-environment jsdom
//
// WorktreeRow — the sync affordance on a dirty worktree.
//
// The live incident these pin: a dirty worktree's sync button looked like a
// working control — the operator clicked it, the spinner ran, the refusal went
// to the log only, and the badge stayed. The row now says up front that the
// sync is blocked: the icon drops to the disabled colour, a `blocked` marker
// renders beside it, and the tooltip carries the remediation (commit or
// stash). Clicking still fires the sync so the refusal toast (with the same
// message) appears — the row is honest, not inert.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: (_t, key) => `var(--${String(key)})` }),
}))
vi.mock('../git/Tooltip', () => ({
  Tooltip: ({ text, children }: { text: string; children: React.ReactNode }) =>
    React.createElement('span', { 'data-tooltip': text }, children),
}))

import { WorktreeRow } from '../WorktreeRow'
import type { WorktreeInventoryEntry } from '../../../shared/types'

function entry(over: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  return {
    worktreePath: '/wt/proj-a1',
    branchName: 'wt/a1',
    label: 'proj-a1',
    sourceBranch: 'josh',
    head: 'abc1234',
    lastCommitSubject: 'feat: things',
    isDirty: false,
    unlandedCommitCount: 1,
    needsSync: true,
    safeToDiscard: false,
    ...over,
  }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const onSync = vi.fn()

function render(e: WorktreeInventoryEntry): void {
  act(() => {
    root.render(React.createElement(WorktreeRow, {
      entry: e,
      onOpen: () => {}, onSync, onMenu: () => {}, onResolve: () => {},
    }))
  })
}

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

describe('WorktreeRow — sync affordance vs dirty state', () => {
  it('shows a plain sync control on a clean worktree', () => {
    render(entry({ isDirty: false }))
    expect(host.querySelector('[data-testid="worktree-sync-wt/a1"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="worktree-word-wt/a1-sync-blocked"]')).toBeNull()
  })

  it('marks the sync as blocked on a dirty worktree, with the remediation in the tooltip', () => {
    // RED before the fix: the dirty row rendered the same working-looking
    // button whose click was silently refused.
    render(entry({ isDirty: true }))

    expect(host.querySelector('[data-testid="worktree-word-wt/a1-sync-blocked"]')).not.toBeNull()
    const tips = Array.from(host.querySelectorAll('[data-tooltip]'))
      .map((n) => n.getAttribute('data-tooltip') ?? '')
    expect(tips.some((t) => t.includes('uncommitted changes') && t.includes('Commit or stash'))).toBe(true)
  })

  // Reverses an earlier decision, deliberately. ba62fca6 let the click through
  // so the refusal TOAST could deliver the remediation, which was right when the
  // alternative was an inert button with no explanation. The row now carries that
  // remediation in its tooltip before the click, so firing a verb guaranteed to
  // refuse only spends a round trip restating what the row already says.
  it('refuses the click when dirty, because the tooltip already carries the remediation', () => {
    render(entry({ isDirty: true }))

    const btn = host.querySelector('[data-testid="worktree-sync-wt/a1"]') as HTMLButtonElement
    act(() => { btn.click() })

    expect(btn.disabled).toBe(true)
    expect(onSync).not.toHaveBeenCalled()
  })

  it('keeps the tooltip reachable on the disabled control', () => {
    // A disabled button fires no pointer events, so the hover has to land on the
    // wrapper -- otherwise disabling it would also hide the reason.
    render(entry({ isDirty: true }))

    const btn = host.querySelector('[data-testid="worktree-sync-wt/a1"]') as HTMLElement
    expect(btn.style.pointerEvents).toBe('none')
  })

  it('still fires the sync on a clean worktree', () => {
    render(entry({ isDirty: false }))
    act(() => {
      (host.querySelector('[data-testid="worktree-sync-wt/a1"]') as HTMLButtonElement).click()
    })
    expect(onSync).toHaveBeenCalled()
  })

  it('shows no sync control at all when the base has not moved', () => {
    render(entry({ needsSync: false, isDirty: true }))
    expect(host.querySelector('[data-testid="worktree-sync-wt/a1"]')).toBeNull()
  })
})
