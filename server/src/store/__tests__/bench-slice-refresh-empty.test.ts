/**
 * A bench refresh that finds no benches records no entry.
 *
 * The Studio read model is the union of every machine's benches and prefers
 * this machine's at a shared key. An empty list recorded for a path (every
 * path another machine's conversation names, since this machine holds no
 * bench records for it) hid the benches that machine really has.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationWorkspace } from '@ion/shared/types'
import type { State } from '../session-store-types'

vi.mock('../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

const mockBenchList = vi.fn()
const mockBenchRefreshStaleness = vi.fn()
vi.mock('../host-api', () => ({
  echoUserTurnToStudio: vi.fn(),
  benchList: (...args: unknown[]) => mockBenchList(...args),
  benchRefreshStaleness: (...args: unknown[]) => mockBenchRefreshStaleness(...args),
}))

import { createBenchSlice } from '../slices/bench-slice'

const REPO = '/repo'

const bench: IntegrationWorkspace = {
  repoPath: REPO,
  sourceBranch: 'main',
  benchPath: '/bench/main',
  benchBranch: 'ion/bench/main',
  members: [],
  baseSha: 'base',
  lastBuiltAt: 0,
}

function harness(initial: Partial<Pick<State, 'benchWorkspaces' | 'benchSourceTips'>> = {}) {
  let state: Record<string, unknown> = {
    benchWorkspaces: initial.benchWorkspaces ?? new Map(),
    benchSourceTips: initial.benchSourceTips ?? new Map(),
    benchRetired: new Map(),
  }
  const set = (update: (current: State) => Partial<State>): void => {
    state = { ...state, ...update(state as unknown as State) }
  }
  const get = (): State => state as unknown as State
  const slice = createBenchSlice(
    set as unknown as Parameters<typeof createBenchSlice>[0],
    get as unknown as Parameters<typeof createBenchSlice>[1],
  )
  state = { ...state, ...slice }
  return { state: (): State => state as unknown as State, refreshBench: slice.refreshBench! }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockBenchRefreshStaleness.mockImplementation(async () => ({ workspace: bench }))
})

describe('refreshBench with no benches', () => {
  it('records nothing for a path with no benches', async () => {
    mockBenchList.mockResolvedValue({ workspaces: [], tips: {} })
    const store = harness()

    await store.refreshBench('/Users/elsewhere/repo')

    expect(store.state().benchWorkspaces.has('/Users/elsewhere/repo')).toBe(false)
    expect(store.state().benchSourceTips.has('/Users/elsewhere/repo')).toBe(false)
  })

  it('drops the entry when the last bench is gone', async () => {
    mockBenchList.mockResolvedValue({ workspaces: [], tips: {} })
    const store = harness({
      benchWorkspaces: new Map([[REPO, [bench]]]),
      benchSourceTips: new Map([[REPO, { main: 'abc' }]]),
    })

    await store.refreshBench(REPO)

    expect(store.state().benchWorkspaces.has(REPO)).toBe(false)
    expect(store.state().benchSourceTips.has(REPO)).toBe(false)
  })

  it('still records a repository that has a bench', async () => {
    mockBenchList.mockResolvedValue({ workspaces: [bench], tips: { main: 'abc' } })
    const store = harness()

    await store.refreshBench(REPO)

    expect(store.state().benchWorkspaces.get(REPO)).toEqual([bench])
  })
})
