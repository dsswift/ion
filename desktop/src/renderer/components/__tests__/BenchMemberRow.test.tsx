// @vitest-environment jsdom
//
// BenchMemberRow status rendering.
//
// The row's one job is to state, truthfully, what the bench holds for a member.
// The status text is the whole signal, so each state must name itself:
//
//  - `pending` shows `no commits yet`, NOT a pinned sha. Its pin carries no
//    commits, so printing `@abc1234` would claim a contribution that does not
//    exist. This is the state whose mishandling deleted the member entirely.
//  - `pending` offers no Update button: there is nothing newer to advance to.
//  - The status text had a fallthrough tail (`: member.pinnedSha ? '@sha'`) that
//    printed a bare sha for any unenumerated status, so a state holding nothing
//    read as "integrated at this commit".
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000000' }),
}))

vi.mock('../git/Tooltip', () => ({
  Tooltip: ({ text, children }: { text: string; children: React.ReactNode }) =>
    React.createElement('div', { 'data-tooltip': text }, children),
}))

import { BenchMemberRow } from '../BenchMemberRow'
import type { IntegrationMember, MemberStatus } from '../../../shared/types'

function member(status: MemberStatus, over: Partial<IntegrationMember> = {}): IntegrationMember {
  return {
    worktreePath: '/wt/a',
    branchName: 'wt/a',
    label: 'a',
    enabled: true,
    pinnedSha: 'abc1234def5678',
    pinnedTreeHash: 'tree1234',
    pinnedBaseSha: 'base1234',
    currentTreeHash: 'tree1234',
    status,
    ...over,
  }
}

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

function render(m: IntegrationMember): void {
  act(() => {
    root.render(
      React.createElement(BenchMemberRow, {
        member: m,
        onToggleEnabled: () => {},
        onUpdate: () => {},
        onRemove: () => {},
        onOpen: () => {},
      }),
    )
  })
}

function statusText(): string {
  return host.querySelector('[data-testid="bench-status-wt/a"]')?.textContent ?? ''
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('BenchMemberRow — status text names every state', () => {
  it('renders "no commits yet" for a pending member and never its sha', () => {
    // The pin is the feature-branch tip here, so a sha would be actively
    // misleading: nothing of this member is in the bench.
    render(member('pending', { pinnedSha: 'abc1234', pinnedBaseSha: 'abc1234' }))
    expect(statusText()).toBe('no commits yet')
    expect(statusText()).not.toContain('abc1234')
  })

  it('offers no Update button for a pending member', () => {
    render(member('pending', { pinnedSha: 'abc1234', pinnedBaseSha: 'abc1234' }))
    expect(host.querySelector('[data-testid="bench-update-wt/a"]')).toBeNull()
  })

  it('keeps Remove available for a pending member', () => {
    // The operator must be able to drop a worktree they decided not to pursue.
    render(member('pending', { pinnedSha: 'abc1234', pinnedBaseSha: 'abc1234' }))
    expect(host.querySelector('[data-testid="bench-remove-wt/a"]')).not.toBeNull()
  })

  it('shows the pinned sha for an integrated member', () => {
    render(member('integrated'))
    expect(statusText()).toBe('@abc1234')
  })

  it('shows the pinned sha plus stale, and an Update button', () => {
    render(member('stale', { currentTreeHash: 'moved' }))
    expect(statusText()).toBe('@abc1234 · stale')
    expect(host.querySelector('[data-testid="bench-update-wt/a"]')).not.toBeNull()
  })

  it('names landed, conflicted, missing, and excluded without a bare sha', () => {
    // The fallthrough these pin: `landed` previously printed `@abc1234`, which
    // read as a pending merge rather than content already in the base.
    for (const [status, text] of [
      ['landed', 'landed'],
      ['conflicted', 'conflict'],
      ['missing', 'missing'],
      ['excluded', 'excluded'],
    ] as Array<[MemberStatus, string]>) {
      render(member(status, status === 'excluded' ? { enabled: false } : {}))
      expect(statusText(), status).toBe(text)
    }
  })

  it('gives a pending member a tooltip that says what unblocks it', () => {
    render(member('pending', { pinnedSha: 'abc1234', pinnedBaseSha: 'abc1234' }))
    const el = host.querySelector('[data-tooltip]')
    const tips = Array.from(host.querySelectorAll('[data-tooltip]'))
      .map((n) => n.getAttribute('data-tooltip'))
    expect(el).not.toBeNull()
    expect(tips.some((t) => (t ?? '').includes('nothing to integrate until this worktree has a commit')))
      .toBe(true)
  })
})
