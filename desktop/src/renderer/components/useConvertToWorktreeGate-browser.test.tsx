// @vitest-environment jsdom
/**
 * The browser-host path for useConvertToWorktreeGate. Separate from any
 * Electron-path test, which would drive real ElectronStudioHost resolution
 * via window.ion -- host-instance.ts caches its resolved host class for the
 * module's lifetime by design, so mocking host-instance directly here is
 * what lets the test supply a browser Studio client's capability list.
 *
 * Every git verb is bridged over the studio-wire on every host, so the hook
 * probes repo-ness unconditionally -- there is no capability gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { TabState } from '@ion/shared/types'

const { gitIsRepo, gitChanges, capabilities } = vi.hoisted(() => ({
  gitIsRepo: vi.fn().mockResolvedValue({ isRepo: true }),
  gitChanges: vi.fn().mockResolvedValue({ files: [] }),
  capabilities: vi.fn<() => string[]>(),
}))

vi.mock('../host/host-instance', () => ({
  host: { shell: { gitIsRepo, gitChanges }, capabilities },
}))
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: { conversationPanes: Map<string, unknown> }) => unknown) => selector({ conversationPanes: new Map() }),
    { getState: () => ({ conversationPanes: new Map() }) },
  ),
}))
vi.mock('@ion/server/store/slices/session-busy-guard', () => ({
  evaluateSessionBusyGuard: () => ({ blocked: false }),
}))

import { useConvertToWorktreeGate, type ConvertToWorktreeGate } from './useConvertToWorktreeGate'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tab = {
  id: 'tab-1',
  workingDirectory: '/repo',
  worktree: undefined,
  status: 'idle',
  bashExecuting: false,
} as unknown as TabState

let result: ConvertToWorktreeGate | null = null
function Consumer({ t }: { t: TabState }): null {
  result = useConvertToWorktreeGate(t)
  return null
}

beforeEach(() => {
  gitIsRepo.mockClear()
  gitChanges.mockClear()
  result = null
})

describe('useConvertToWorktreeGate on a browser Studio client (git bridged over the studio-wire)', () => {
  it('probes repo-ness and dirtiness over host.shell.git*', async () => {
    capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Consumer t={tab} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(gitIsRepo).toHaveBeenCalledTimes(1)
    expect(gitChanges).toHaveBeenCalledWith('/repo')
    expect(result?.show).toBe(true)
    act(() => root.unmount())
    container.remove()
  })
})
