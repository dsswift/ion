// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: (_target, key) => `var(--${String(key)})` }),
}))
vi.mock('../git/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('../git/HoverCard', () => ({
  HoverCard: ({ children }: { children: React.ReactNode }) => children,
}))

import { WorktreeRow, WORKTREE_ROW_GUTTER_WIDTH } from '../WorktreeRow'
import type { IntegrationMember, WorktreeInventoryEntry } from '../../../shared/types'

const BRANCH = 'wt/a1'
const onToggleMembership = vi.fn()

function entry(over: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  return {
    worktreePath: '/wt/proj-a1', branchName: BRANCH, label: 'proj-a1', sourceBranch: 'main',
    head: 'abc1234', lastCommitSubject: 'feat: things', isDirty: false,
    unlandedCommitCount: 0, needsSync: false, safeToDiscard: false, ...over,
  }
}

function member(over: Partial<IntegrationMember> = {}): IntegrationMember {
  return {
    worktreePath: '/wt/proj-a1', branchName: BRANCH, pin: 'current', merge: 'merged',
    pinnedSha: 'abc1234', pinnedTreeHash: 'tree', pinnedBaseSha: 'base', currentTreeHash: 'tree', ...over,
  }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const query = (testId: string): HTMLElement | null => host.querySelector(`[data-testid="${testId}"]`)

function render(props: Partial<Parameters<typeof WorktreeRow>[0]> = {}): void {
  act(() => {
    root.render(<WorktreeRow entry={entry()} onOpen={() => {}} onSync={() => {}} onMenu={() => {}} onToggleMembership={onToggleMembership} {...props} />)
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

describe('WorktreeRow binary bench membership', () => {
  it('shows a hollow control when the worktree is not a bench member', () => {
    render()
    expect(query(`worktree-enrollment-${BRANCH}`)?.getAttribute('data-enrollment')).toBe('none')
    expect(query(`worktree-bench-toggle-${BRANCH}`)?.getAttribute('aria-pressed')).toBe('false')
  })

  it('shows a solid control for every bench member', () => {
    render({ membership: member(), order: 1 })
    expect(query(`worktree-enrollment-${BRANCH}`)?.getAttribute('data-enrollment')).toBe('member')
    expect(query(`worktree-bench-toggle-${BRANCH}`)?.getAttribute('aria-pressed')).toBe('true')
  })

  it('adds or removes membership with one click', () => {
    render()
    act(() => query(`worktree-bench-toggle-${BRANCH}`)?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onToggleMembership).toHaveBeenCalledTimes(1)

    render({ membership: member(), order: 1 })
    act(() => query(`worktree-bench-toggle-${BRANCH}`)?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onToggleMembership).toHaveBeenCalledTimes(2)
  })

  it('keeps the membership slot aligned for members and non-members', () => {
    render()
    const nonMemberWidth = query(`worktree-enrollment-${BRANCH}`)?.style.width
    render({ membership: member(), order: 1 })
    expect(query(`worktree-enrollment-${BRANCH}`)?.style.width).toBe(nonMemberWidth)
    expect(query(`worktree-gutter-${BRANCH}`)?.style.width).toBe(`${WORKTREE_ROW_GUTTER_WIDTH}px`)
  })

  it('still reports a hidden behind pin when a conflict has priority', () => {
    render({ membership: member({ pin: 'behind', merge: 'conflicted', conflictPaths: ['x.ts'] }), order: 1 })
    expect(query(`worktree-bench-conflict-${BRANCH}`)).not.toBeNull()
    expect(query(`worktree-word-${BRANCH}-behind`)).not.toBeNull()
  })
})
