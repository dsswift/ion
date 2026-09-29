// @vitest-environment jsdom
/**
 * Capability gate: `WorktreeOverlapLauncher` calls
 * `host.shell.openWorktreeOverlap`, which opens a separate native Electron
 * window with no browser-safe equivalent. On a `BrowserStudioHost` (missing
 * `nativeShell`) the button must not render at all — otherwise a click throws
 * synchronously.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const openWorktreeOverlap = vi.hoisted(() => vi.fn())
let caps: string[] = []

vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../git/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement('span', null, children),
}))
vi.mock('../../host/host-instance', () => ({
  host: {
    shell: { openWorktreeOverlap },
    capabilities: () => caps,
  },
}))

import { WorktreeOverlapLauncher } from '../WorktreeOverlapLauncher'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
})

function mount(): void {
  act(() => {
    root = createRoot(container)
    root.render(React.createElement(WorktreeOverlapLauncher, { repoPath: '/repo' }))
  })
}

describe('WorktreeOverlapLauncher nativeShell gate', () => {
  it('renders nothing on a browser host lacking nativeShell', () => {
    caps = ['terminal', 'git', 'files', 'questions', 'graph']
    mount()
    expect(container.querySelector('[data-testid="worktree-overlap-launcher"]')).toBeNull()
  })

  it('renders the launcher on an Electron host with nativeShell', () => {
    caps = ['nativeShell']
    mount()
    expect(container.querySelector('[data-testid="worktree-overlap-launcher"]')).not.toBeNull()
  })
})
