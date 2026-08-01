/**
 * Bench slice — the absorbed-into-base notice.
 *
 * `BenchRebuildResult.retired` exists so the UI can say what a rebuild absorbed
 * "rather than having rows vanish silently" (its own doc comment). Nothing
 * consumed it: the IPC layer logged a count and the renderer discarded the value,
 * so a member retiring looked exactly like the bench losing a worktree. That is
 * how the pending-member defect was first reported.
 *
 * These tests pin the notice's lifecycle: recorded on rebuild and on both Update
 * verbs, scoped per source branch, cleared when a later rebuild absorbs nothing,
 * and dismissible.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

import { createBenchSlice } from '../slices/bench-slice'
import type { State } from '../session-store-types'
import type { IntegrationMember, BenchRebuildResult } from '../../../shared/types'

const REPO = '/Users/test/project'

function member(branchName: string): IntegrationMember {
  return {
    worktreePath: `/wt/${branchName}`,
    branchName,
    label: branchName,
    enabled: true,
    pinnedSha: 'abc1234',
    pinnedTreeHash: 'tree1',
    pinnedBaseSha: 'base1',
    currentTreeHash: 'tree1',
    status: 'landed',
  }
}

/**
 * Minimal store harness. The slice only needs `set`, `get`, and the two Maps it
 * touches; a full store would obscure which state the action actually writes.
 */
function harness(rebuildResult: BenchRebuildResult) {
  let state: Record<string, unknown> = {
    benchRetired: new Map<string, Map<string, IntegrationMember[]>>(),
    benchWorkspaces: new Map(),
    benchSourceTips: new Map(),
  }
  const set = (fn: (s: Record<string, unknown>) => Record<string, unknown>): void => {
    state = { ...state, ...fn(state) }
  }
  const get = (): Record<string, unknown> => state

  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    ion: {
      benchRebuild: vi.fn().mockResolvedValue(rebuildResult),
      benchUpdateMember: vi.fn().mockResolvedValue(rebuildResult),
      benchUpdateAll: vi.fn().mockResolvedValue(rebuildResult),
      benchList: vi.fn().mockResolvedValue({ workspaces: [], tips: {} }),
      benchRefreshStaleness: vi.fn().mockResolvedValue({ workspace: null }),
    },
  }

  const slice = createBenchSlice(
    set as unknown as Parameters<typeof createBenchSlice>[0],
    get as unknown as Parameters<typeof createBenchSlice>[1],
  ) as Partial<State>

  // The slice calls its own refreshBench through get(), so the harness state must
  // carry the slice's actions the way the real store does.
  state = { ...state, ...slice }

  const retiredFor = (branch: string): IntegrationMember[] =>
    (state.benchRetired as Map<string, Map<string, IntegrationMember[]>>)
      .get(REPO)?.get(branch) ?? []

  return { slice, retiredFor }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('benchRebuild — recording what was absorbed', () => {
  it('records the retired members for the workspace that rebuilt', async () => {
    const { slice, retiredFor } = harness({ ok: true, retired: [member('wt/a')] })
    await slice.benchRebuild!(REPO, 'josh')
    expect(retiredFor('josh').map((m) => m.branchName)).toEqual(['wt/a'])
  })

  it('records nothing when the rebuild absorbed nothing', async () => {
    const { slice, retiredFor } = harness({ ok: true, retired: [] })
    await slice.benchRebuild!(REPO, 'josh')
    expect(retiredFor('josh')).toEqual([])
  })

  it('treats an absent retired list as nothing absorbed', async () => {
    // A refusal (dirty bench) carries no `retired` at all; it must not throw and
    // must not leave a stale notice.
    const { slice, retiredFor } = harness({ ok: false, error: 'dirty' })
    await slice.benchRebuild!(REPO, 'josh')
    expect(retiredFor('josh')).toEqual([])
  })

  it('clears a previous notice once a later rebuild absorbs nothing', async () => {
    // Otherwise the notice outlives the event it describes and the operator sees
    // a member named as absorbed on every subsequent build.
    const first = harness({ ok: true, retired: [member('wt/a')] })
    await first.slice.benchRebuild!(REPO, 'josh')
    expect(first.retiredFor('josh')).toHaveLength(1)

    ;(globalThis as unknown as { window: { ion: Record<string, unknown> } })
      .window.ion.benchRebuild = vi.fn().mockResolvedValue({ ok: true, retired: [] })
    await first.slice.benchRebuild!(REPO, 'josh')
    expect(first.retiredFor('josh')).toEqual([])
  })

  it('keeps notices separate per source branch', async () => {
    // A repo integrating into two feature branches has two benches; one
    // absorbing a member must not annotate the other.
    const { slice, retiredFor } = harness({ ok: true, retired: [member('wt/a')] })
    await slice.benchRebuild!(REPO, 'josh')
    expect(retiredFor('josh')).toHaveLength(1)
    expect(retiredFor('other')).toEqual([])
  })
})

describe('the Update verbs record absorption too', () => {
  it('records from benchUpdateMember', async () => {
    // Update rebuilds, so it can absorb a member that landed meanwhile.
    const { slice, retiredFor } = harness({ ok: true, retired: [member('wt/a')] })
    await slice.benchUpdateMember!(REPO, 'josh', '/wt/wt/a')
    expect(retiredFor('josh')).toHaveLength(1)
  })

  it('records from benchUpdateAll', async () => {
    const { slice, retiredFor } = harness({ ok: true, retired: [member('wt/b')] })
    await slice.benchUpdateAll!(REPO, 'josh')
    expect(retiredFor('josh').map((m) => m.branchName)).toEqual(['wt/b'])
  })
})

describe('clearBenchRetired — dismissal', () => {
  it('drops the notice for one branch and leaves the other', async () => {
    const { slice, retiredFor } = harness({ ok: true, retired: [member('wt/a')] })
    await slice.benchRebuild!(REPO, 'josh')
    await slice.benchRebuild!(REPO, 'other')
    expect(retiredFor('josh')).toHaveLength(1)
    expect(retiredFor('other')).toHaveLength(1)

    slice.clearBenchRetired!(REPO, 'josh')

    expect(retiredFor('josh')).toEqual([])
    expect(retiredFor('other')).toHaveLength(1)
  })

  it('is a no-op when there is nothing to dismiss', () => {
    const { slice, retiredFor } = harness({ ok: true, retired: [] })
    slice.clearBenchRetired!(REPO, 'josh')
    expect(retiredFor('josh')).toEqual([])
  })
})
