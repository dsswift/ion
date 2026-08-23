import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const window = {
    isDestroyed: vi.fn(() => false),
    show: vi.fn(),
    focus: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    moveTop: vi.fn(),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    isVisible: vi.fn(() => true),
    showInactive: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    webContents: {
      id: 1,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    },
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
  }
  return { window }
})

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(function BrowserWindow() { return mocks.window }),
}))
vi.mock('../logger', () => ({ log: vi.fn(), error: vi.fn() }))
vi.mock('../state', () => ({ state: { worktreeOverlapWindow: null } }))
vi.mock('../studio-window-manager', () => ({ applyStudioActivationPolicy: vi.fn() }))

import { BrowserWindow } from 'electron'
import { state } from '../state'
import { openWorktreeOverlapWindow } from '../worktree-overlap-window'

beforeEach(() => {
  vi.clearAllMocks()
  ;(state as { worktreeOverlapWindow: unknown }).worktreeOverlapWindow = null
})

describe('worktree overlap window', () => {
  it('allows the compact responsive layout width', () => {
    openWorktreeOverlapWindow({ repoPath: '/repo' })

    expect(BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({
      minWidth: 560,
      minHeight: 520,
    }))
  })
})
