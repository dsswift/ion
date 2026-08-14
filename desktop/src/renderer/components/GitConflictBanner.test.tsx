// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const alerts = new Map([['/repo', { operationState: 'merging', label: 'repo' }]])
vi.mock('../stores/sessionStore', () => ({
  useSessionStore: <T,>(selector: (state: {
    worktreeInventory: Map<string, never[]>
    gitConflictAlerts: typeof alerts
  }) => T): T => selector({ worktreeInventory: new Map(), gitConflictAlerts: alerts }),
}))
vi.mock('../theme', () => ({
  useColors: () => new Proxy({}, { get: (_target, key) => `var(--${String(key)})` }),
}))
vi.mock('@phosphor-icons/react', () => ({ Warning: () => null }))
vi.mock('./git/ConflictsDialog', () => ({
  ConflictsDialog: ({ directory }: { directory: string }) => <div data-testid="conflicts-dialog">{directory}</div>,
}))

import { GitConflictBanner } from './GitConflictBanner'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('GitConflictBanner', () => {
  it('keeps an immediate repo-root conflict resolvable without a floating popup', () => {
    act(() => root.render(<GitConflictBanner repoPath="/repo" />))

    expect(host.textContent).toContain('Conflicts in repo')
    const resolve = host.querySelector('[data-testid="git-panel-conflict-resolve"]') as HTMLButtonElement
    act(() => resolve.click())

    expect(host.querySelector('[data-testid="conflicts-dialog"]')?.textContent).toBe('/repo')
  })
})
