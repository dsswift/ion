import { beforeEach, describe, expect, it, vi } from 'vitest'

const { onHandlers, handlers, openWindow } = vi.hoisted(() => ({
  onHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  openWindow: vi.fn(),
}))
vi.mock('electron', () => ({ ipcMain: {
  on: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => onHandlers.set(channel, handler)),
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
} }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('@ion/server/ipc-validation', () => ({ isValidProjectPath: (p: unknown) => typeof p === 'string' && p.startsWith('/') }))
vi.mock('../../worktree-overlap-window', () => ({ openWorktreeOverlapWindow: openWindow, worktreeOverlapContext: vi.fn((id: number) => (id === 1 ? { repoPath: '/repo', sourceBranch: 'main' } : null)) }))

import { IPC } from '@ion/shared/types'
import { registerWorktreeOverlapIpc } from '../worktree-overlap'

beforeEach(() => { onHandlers.clear(); handlers.clear(); vi.clearAllMocks(); registerWorktreeOverlapIpc() })

describe('worktree overlap window IPC', () => {
  it('opens the window only for a valid context', () => {
    const open = onHandlers.get(IPC.WORKTREE_OVERLAP_OPEN)!
    open({}, { repoPath: 'relative' })
    open({}, { repoPath: '/repo', sourceBranch: 3 })
    expect(openWindow).not.toHaveBeenCalled()
    open({}, { repoPath: '/repo', sourceBranch: 'main' })
    expect(openWindow).toHaveBeenCalledWith({ repoPath: '/repo', sourceBranch: 'main' })
  })

  it('answers the calling window with the context it was opened for', () => {
    const context = handlers.get(IPC.WORKTREE_OVERLAP_CONTEXT)!
    expect(context({ sender: { id: 1 } })).toEqual({ repoPath: '/repo', sourceBranch: 'main' })
    expect(context({ sender: { id: 2 } })).toBeNull()
  })

  it('registers no analysis verbs: those are the server\'s worktree.overlap.* actions', () => {
    expect([...handlers.keys()]).toEqual([IPC.WORKTREE_OVERLAP_CONTEXT])
  })
})
