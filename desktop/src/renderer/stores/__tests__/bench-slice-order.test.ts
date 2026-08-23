import { describe, expect, it, vi } from 'vitest'
import type { IntegrationMember, IntegrationWorkspace } from '../../../shared/types'
import type { State } from '../session-store-types'
import { createBenchSlice } from '../slices/bench-slice'
import { createBenchAssemblySlice } from '../slices/bench-slice-assembly'

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

const REPO = '/repo'
const BRANCH = 'main'

function member(name: string): IntegrationMember {
  return {
    worktreePath: `/worktrees/${name}`,
    branchName: `wt/${name}`,
    pin: 'current',
    merge: 'unbuilt',
    pinnedSha: name,
    pinnedTreeHash: name,
    pinnedBaseSha: 'base',
    currentTreeHash: name,
  }
}

function workspace(names: string[]): IntegrationWorkspace {
  return {
    repoPath: REPO,
    sourceBranch: BRANCH,
    benchPath: '/bench/main',
    benchBranch: 'ion/bench/main',
    members: names.map(member),
    baseSha: 'base',
    lastBuiltAt: 0,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function harness(initial: IntegrationWorkspace) {
  let state: Record<string, unknown> = {
    benchWorkspaces: new Map([[REPO, [initial]]]),
    benchSourceTips: new Map([[REPO, {}]]),
    benchRetired: new Map(),
  }
  const set = (update: (current: State) => Partial<State>): void => {
    state = { ...state, ...update(state as unknown as State) }
  }
  const get = (): State => state as unknown as State
  const navigation = createBenchSlice(
    set as unknown as Parameters<typeof createBenchSlice>[0],
    get as unknown as Parameters<typeof createBenchSlice>[1],
  )
  const assembly = createBenchAssemblySlice(
    set as unknown as Parameters<typeof createBenchAssemblySlice>[0],
    get as unknown as Parameters<typeof createBenchAssemblySlice>[1],
  )
  state = { ...state, ...navigation, ...assembly }
  return {
    state: (): State => state as unknown as State,
    refreshBench: navigation.refreshBench!,
    benchSetOrder: assembly.benchSetOrder!,
  }
}

describe('bench member order cache', () => {
  it('applies the mutation response without waiting for another read', async () => {
    const before = workspace(['first', 'second'])
    const after = workspace(['second', 'first'])
    const benchSetOrder = vi.fn().mockResolvedValue({ workspace: after })
    ;(globalThis as unknown as { window: { ion: Record<string, unknown> } }).window = {
      ion: { benchSetOrder },
    }
    const store = harness(before)

    await store.benchSetOrder(REPO, BRANCH, '/worktrees/second', 0)

    expect(store.state().benchWorkspaces.get(REPO)?.[0]?.members.map((item) => item.branchName)).toEqual([
      'wt/second',
      'wt/first',
    ])
  })

  it('does not let an older refresh restore the order from before the mutation', async () => {
    const before = workspace(['first', 'second'])
    const after = workspace(['second', 'first'])
    const listing = deferred<{ workspaces: IntegrationWorkspace[]; tips: Record<string, string> }>()
    ;(globalThis as unknown as { window: { ion: Record<string, unknown> } }).window = {
      ion: {
        benchList: vi.fn(() => listing.promise),
        benchRefreshStaleness: vi.fn(async (_repoPath: string, _sourceBranch: string) => ({ workspace: before })),
        benchSetOrder: vi.fn(async () => ({ workspace: after })),
      },
    }
    const store = harness(before)

    const staleRefresh = store.refreshBench(REPO)
    await store.benchSetOrder(REPO, BRANCH, '/worktrees/second', 0)
    listing.resolve({ workspaces: [before], tips: {} })
    await staleRefresh

    expect(store.state().benchWorkspaces.get(REPO)?.[0]?.members.map((item) => item.branchName)).toEqual([
      'wt/second',
      'wt/first',
    ])
  })
})
