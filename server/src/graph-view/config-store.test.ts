import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  ionExists: false,
  callbacks: new Map<string, (event: string, filename: string | Buffer | null) => void>(),
  broadcast: vi.fn(),
}))

vi.mock('fs', () => ({
  // The real store builds this path with `join()`, which is platform-native
  // (`\project\.ion` on Windows, `/project/.ion` elsewhere). Matching on the
  // basename alone keeps the mock correct on every host OS.
  existsSync: vi.fn((path: string) => path.endsWith('.ion') ? state.ionExists : false),
  readFileSync: vi.fn(() => '{}'),
  watch: vi.fn((path: string, callback: (event: string, filename: string | Buffer | null) => void) => {
    state.callbacks.set(path, callback)
    return { close: vi.fn(), on: vi.fn() }
  }),
}))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn() }))
vi.mock('../settings-store', () => ({ readSettings: vi.fn(() => ({})) }))
vi.mock('../broadcast', () => ({ broadcast: state.broadcast }))

import { _resetGraphViewConfigStoreForTest, getGraphViewConfig, watchProject } from './config-store'

afterEach(() => {
  vi.useRealTimers()
  _resetGraphViewConfigStoreForTest()
  state.callbacks.clear()
  state.ionExists = false
  state.broadcast.mockClear()
})

describe('Graph View configuration watcher', () => {
  it('refreshes cached configuration when a previously absent .ion directory appears', async () => {
    vi.useFakeTimers()
    const projectPath = '/project'
    getGraphViewConfig(projectPath)
    watchProject(projectPath)

    state.ionExists = true
    state.callbacks.get(projectPath)?.('rename', '.ion')
    await vi.advanceTimersByTimeAsync(250)

    expect(state.broadcast).toHaveBeenCalled()
  })
})
