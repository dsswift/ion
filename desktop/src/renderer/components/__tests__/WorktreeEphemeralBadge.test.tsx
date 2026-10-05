// @vitest-environment jsdom
//
// WorktreeEphemeralBadge — the worktree list's ephemeral marker: shown while a
// worktree closes with its conversation, and turned into a "kept" note with the
// reason once a close kept it.
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

import { WorktreeEphemeralBadge, EPHEMERAL_TOOLTIP } from '../WorktreeEphemeralBadge'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function render(entry: Parameters<typeof WorktreeEphemeralBadge>[0]['entry']): void {
  act(() => root.render(React.createElement(WorktreeEphemeralBadge, { entry })))
}

describe('WorktreeEphemeralBadge', () => {
  it('renders nothing for an ordinary worktree', () => {
    render({ branchName: 'wt/a' })
    expect(host.innerHTML).toBe('')
  })

  it('marks an ephemeral worktree and explains what that means', () => {
    render({ branchName: 'wt/a', ephemeral: true })
    const badge = host.querySelector('[data-testid="worktree-ephemeral-wt/a"]')
    expect(badge?.textContent).toBe('ephemeral')
    expect(badge?.getAttribute('data-kept')).toBe('false')
    expect(host.querySelector('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(EPHEMERAL_TOOLTIP)
  })

  it('tells the operator why a close kept the worktree', () => {
    render({ branchName: 'wt/a', ephemeralKeptReason: 'This worktree has 2 commits not yet landed in main.' })
    const badge = host.querySelector('[data-testid="worktree-ephemeral-wt/a"]')
    expect(badge?.textContent).toBe('kept')
    expect(host.querySelector('[data-tooltip]')?.getAttribute('data-tooltip'))
      .toBe('Kept when its conversation closed: This worktree has 2 commits not yet landed in main.')
  })
})
