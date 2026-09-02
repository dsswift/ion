import { beforeEach, describe, expect, it, vi } from 'vitest'

const { terminalCreate, terminalWrite, terminalDestroy } = vi.hoisted(() => ({
  terminalCreate: vi.fn(() => Promise.resolve()),
  terminalWrite: vi.fn(),
  terminalDestroy: vi.fn(() => Promise.resolve()),
}))

vi.mock('../../components/TerminalPanel', () => ({ destroyTerminalInstance: vi.fn() }))
vi.mock('../../preferences', () => ({
  usePreferencesStore: {
    getState: () => ({
      quickTools: [{ id: 'tool-1', name: 'Serve', command: 'serve {cwd} {branch}' }],
      defaultBaseDirectory: '',
      defaultTallTerminal: false,
      tabGroupMode: 'off',
      tabGroups: [],
    }),
  },
}))
vi.mock('../session-store-helpers', () => ({
  makeLocalTab: () => ({ id: 'new-tab', workingDirectory: '~' }),
  isReusableBlankTerminalTab: () => false,
}))
vi.mock('../worktree-registration', () => ({ resolveRegisteredWorktree: vi.fn(() => Promise.resolve(null)) }))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rWarn: vi.fn() }))

;(globalThis as unknown as { window: { ion: unknown } }).window = {
  ion: {
    terminalCreate,
    terminalWrite,
    terminalDestroy,
    terminalAttach: vi.fn(() => Promise.resolve({ history: '', running: true, exitCode: null, cwd: '/repo', cwdFellBack: false })),
    gitChanges: vi.fn(() => Promise.resolve({ branch: 'feature' })),
  },
}

import type { State, StoreGet, StoreSet } from '../session-store-types'
import { createTerminalSlice } from '../slices/terminal-slice'

function harness(): State {
  const state = {
    tabs: [{ id: 'tab-a', workingDirectory: '/repo', isTerminalOnly: false }],
    terminalPanes: new Map(),
    terminalOpenTabIds: new Set(),
    terminalTallTabId: null,
    terminalBigScreenTabId: null,
    tallViewTabId: null,
    suspendedTallTabId: null,
  } as unknown as State
  const set: StoreSet = (update) => {
    const patch = typeof update === 'function' ? update(state) : update
    Object.assign(state, patch)
  }
  const get: StoreGet = () => state
  Object.assign(state, createTerminalSlice(set, get))
  return state
}

describe('Conversation Terminal Panel owner actions', () => {
  beforeEach(() => {
    terminalCreate.mockClear()
    terminalWrite.mockClear()
    terminalDestroy.mockClear()
  })

  it('creates metadata only after the main-owned PTY starts and opens the panel', async () => {
    const state = harness()
    const id = await state.addTerminalInstance('tab-a', 'user', '/repo/service')

    expect(terminalCreate).toHaveBeenCalledWith(`tab-a:${id}`, '/repo/service')
    expect(state.terminalPanes.get('tab-a')?.instances[0]).toMatchObject({ id, cwd: '/repo/service' })
    expect(state.terminalOpenTabIds.has('tab-a')).toBe(true)
  })

  it('does not publish terminal metadata when PTY creation fails', async () => {
    terminalCreate.mockRejectedValueOnce(new Error('spawn failed'))
    const state = harness()

    await expect(state.addTerminalInstance('tab-a', 'user')).rejects.toThrow('spawn failed')
    expect(state.terminalPanes.size).toBe(0)
  })

  it('starts and writes command terminals without waiting for a viewer mount', async () => {
    const state = harness()
    await state.runInTerminal('tab-a', 'git status')

    const instance = state.terminalPanes.get('tab-a')?.instances[0]
    expect(instance).toBeDefined()
    expect(instance?.kind).toBe('commit')
    expect(terminalCreate).toHaveBeenCalledWith(`tab-a:${instance!.id}`, '/repo')
    expect(terminalWrite).toHaveBeenCalledWith(`tab-a:${instance!.id}`, 'git status\n')
  })

  it('starts and writes a quick tool through the same owner terminal path', async () => {
    const state = harness()
    await state.runQuickTool('tab-a', 'tool-1')

    const instance = state.terminalPanes.get('tab-a')?.instances[0]
    expect(instance).toBeDefined()
    expect(instance?.kind).toBe('tool:tool-1')
    expect(terminalCreate).toHaveBeenCalledTimes(1)
    expect(terminalWrite).toHaveBeenCalledWith(`tab-a:${instance!.id}`, 'serve /repo feature\n')
  })
})
