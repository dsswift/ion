import { beforeEach, describe, expect, it, vi } from 'vitest'

const { terminalCreate, terminalRelaunch, terminalWrite, terminalDestroy, terminalAttach, gitChanges } = vi.hoisted(() => ({
  terminalCreate: vi.fn(() => Promise.resolve()),
  terminalRelaunch: vi.fn((_key: string, _cwd: string) => Promise.resolve()),
  terminalWrite: vi.fn(),
  terminalDestroy: vi.fn(() => Promise.resolve()),
  terminalAttach: vi.fn(() => Promise.resolve({ history: '', running: true, exitCode: null, cwd: '/repo', cwdFellBack: false })),
  gitChanges: vi.fn(() => Promise.resolve({ branch: 'feature' })),
}))

vi.mock('../host-api', () => ({
  echoUserTurnToStudio: vi.fn(),
  terminalCreate,
  terminalRelaunch,
  terminalWrite,
  terminalDestroy,
  terminalAttach,
  gitChanges,
}))
vi.mock('../../components/TerminalPanel', () => ({ destroyTerminalInstance: vi.fn() }))
vi.mock('../../persistence/preferences', () => ({
  usePreferencesStore: {
    getState: () => ({
      quickTools: [{ id: 'tool-1', name: 'Serve', command: 'serve {cwd} {branch}' }],
      defaultBaseDirectory: '',
    }),
  },
}))
vi.mock('../session-store-helpers', () => ({
  makeLocalTab: () => ({ id: 'new-tab', workingDirectory: '~' }),
  isReusableBlankTerminalTab: () => false,
}))
vi.mock('../worktree-registration', () => ({ resolveRegisteredWorktree: vi.fn(() => Promise.resolve(null)) }))
vi.mock('../rendererLogger', () => ({ rDebug: vi.fn(), rWarn: vi.fn() }))

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
    terminalRelaunch.mockClear()
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

  it('tags a terminal with the launch key that created it', async () => {
    const state = harness()
    const id = await state.addTerminalInstance('tab-a', 'user', '/repo/api', 'api', 'dev.yaml/abc/api')

    expect(state.terminalPanes.get('tab-a')?.instances[0]).toMatchObject({ id, label: 'api', launchKey: 'dev.yaml/abc/api' })
  })

  it('relaunches a terminal in place: same pane, new directory and name, made active', async () => {
    const state = harness()
    const first = await state.addTerminalInstance('tab-a', 'user', '/repo/old', 'api', 'dev.yaml/abc/api')
    const second = await state.addTerminalInstance('tab-a', 'user')
    state.terminalOpenTabIds = new Set()

    await state.relaunchTerminalInstance('tab-a', first, '/repo/api', 'API')

    expect(terminalRelaunch).toHaveBeenCalledWith(`tab-a:${first}`, '/repo/api')
    const pane = state.terminalPanes.get('tab-a')!
    expect(pane.instances.map((i) => i.id)).toEqual([first, second])
    expect(pane.instances[0]).toMatchObject({ cwd: '/repo/api', label: 'API', launchKey: 'dev.yaml/abc/api' })
    expect(pane.activeInstanceId).toBe(first)
    expect(state.terminalOpenTabIds.has('tab-a')).toBe(true)
  })

  it('relaunches in the terminal\'s own directory when none is given', async () => {
    const state = harness()
    const id = await state.addTerminalInstance('tab-a', 'user', '/repo/api')

    await state.relaunchTerminalInstance('tab-a', id)

    expect(terminalRelaunch).toHaveBeenLastCalledWith(`tab-a:${id}`, '/repo/api')
  })

  it('refuses to relaunch a terminal that is not open', async () => {
    const state = harness()

    await expect(state.relaunchTerminalInstance('tab-a', 'gone')).rejects.toThrow('not open')
    expect(terminalRelaunch).not.toHaveBeenCalled()
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

describe('ensureTerminalInstance: the owner decides whether a first shell is needed', () => {
  beforeEach(() => { terminalCreate.mockClear() })

  // A client's terminal panel mounts before the owner's terminal state
  // reaches it. Deciding from the client's empty copy added one more shell
  // beside the restored ones on every launch.
  it('creates nothing when the conversation already has shells, and returns the active one', async () => {
    const state = harness()
    Object.assign(state, { tabsReady: true })
    const first = await state.addTerminalInstance('tab-a', 'user', '/repo')
    terminalCreate.mockClear()
    await expect(state.ensureTerminalInstance('tab-a', '/repo')).resolves.toBe(first)
    await expect(state.ensureTerminalInstance('tab-a', '/repo')).resolves.toBe(first)
    expect(terminalCreate).not.toHaveBeenCalled()
    expect(state.terminalPanes.get('tab-a')?.instances).toHaveLength(1)
  })

  it('creates exactly one shell when there is none, even when two windows ask at once', async () => {
    const state = harness()
    Object.assign(state, { tabsReady: true })
    const [a, b] = await Promise.all([state.ensureTerminalInstance('tab-a', '/repo'), state.ensureTerminalInstance('tab-a', '/repo')])
    expect(a).toBe(b)
    expect(terminalCreate).toHaveBeenCalledTimes(1)
    expect(state.terminalPanes.get('tab-a')?.instances).toHaveLength(1)
  })

  it('waits for the restore to put saved shells back before deciding', async () => {
    const state = harness()
    Object.assign(state, { tabsReady: false })
    const pending = state.ensureTerminalInstance('tab-a', '/repo')
    // The restore finishes: the saved shells are back, then tabs are ready.
    state.terminalPanes.set('tab-a', { instances: [{ id: 'saved-1', label: 'Shell', kind: 'user', readOnly: false, cwd: '/repo' }], activeInstanceId: 'saved-1' } as never)
    Object.assign(state, { tabsReady: true })
    await expect(pending).resolves.toBe('saved-1')
    expect(terminalCreate).not.toHaveBeenCalled()
  })
})
