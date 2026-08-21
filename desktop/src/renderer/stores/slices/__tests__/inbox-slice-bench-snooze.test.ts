/**
 * Snooze refuses a bench conversation.
 *
 * A bench is rebuildable scratch space: its branch is recreated from each
 * member's pinned commit on every assembly, so every conversation and terminal
 * in it is ephemeral. Snooze parks a conversation for a later that the next
 * rebuild deletes, which is why the store refuses it outright rather than
 * accepting a wake time it cannot honour.
 *
 * Regression direction: dropping `inBench` from `canSnooze` (or from
 * `actionInput`) turns the refusal tests green-to-red.
 */
import { describe, it, expect, vi } from 'vitest'
import type { State } from '../../session-store-types'
import type { IntegrationWorkspace, TabState } from '../../../../shared/types'

vi.mock('../../../rendererLogger', () => ({
  rDebug: vi.fn(),
  rInfo: vi.fn(),
  rWarn: vi.fn(),
}))
vi.mock('../../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ engineProfiles: [] }) },
}))

import { createInboxSlice } from '../inbox-slice'

const BENCH = '/Users/dev/.ion/integration/ion-josh'
const WORKTREE = '/Users/dev/.ion/worktrees/ion-a3f1'

function tab(id: string, workingDirectory: string): TabState {
  return { id, workingDirectory, snoozedUntil: null, snoozedAt: null } as unknown as TabState
}

function workspace(benchPath: string): IntegrationWorkspace {
  return { benchPath } as unknown as IntegrationWorkspace
}

/**
 * Drives the slice against a minimal store. `conversationPanes` is empty, so
 * every tab reads as "no pending ask, not waiting" — the other two snooze
 * conditions — leaving bench membership as the only variable under test.
 */
function harness(tabs: TabState[], benchPaths: string[]) {
  let state = {
    tabs,
    conversationPanes: new Map(),
    benchWorkspaces: new Map([['/Users/dev/src/ion', benchPaths.map(workspace)]]),
  } as unknown as State
  const set = (updater: (current: State) => Partial<State>): void => {
    state = { ...state, ...updater(state) } as State
  }
  const get = (): State => state
  const slice = createInboxSlice(set as never, get as never)
  return { slice, snoozedUntil: (id: string): number | null | undefined => get().tabs.find((t) => t.id === id)?.snoozedUntil }
}

const WAKE = Date.now() + 3_600_000

describe('snoozeTab bench refusal', () => {
  it('refuses a conversation whose directory is the bench', () => {
    const { slice, snoozedUntil } = harness([tab('bench-talk', BENCH)], [BENCH])
    slice.snoozeTab?.('bench-talk', WAKE)
    expect(snoozedUntil('bench-talk')).toBeNull()
  })

  it('refuses a conversation nested inside the bench', () => {
    const nested = `${BENCH}/desktop/src`
    const { slice, snoozedUntil } = harness([tab('nested', nested)], [BENCH])
    slice.snoozeTab?.('nested', WAKE)
    expect(snoozedUntil('nested')).toBeNull()
  })

  it('still snoozes a worktree conversation', () => {
    const { slice, snoozedUntil } = harness([tab('worktree-talk', WORKTREE)], [BENCH])
    slice.snoozeTab?.('worktree-talk', WAKE)
    expect(snoozedUntil('worktree-talk')).toBe(WAKE)
  })

  it('still snoozes a source-repo conversation when a bench exists in that repo', () => {
    const { slice, snoozedUntil } = harness([tab('source-talk', '/Users/dev/src/ion')], [BENCH])
    slice.snoozeTab?.('source-talk', WAKE)
    expect(snoozedUntil('source-talk')).toBe(WAKE)
  })
})

/**
 * Un-settle refuses a permanently settled record.
 *
 * `settledRecordCanRestore` is the gate; this pins that the store consults it
 * for the ephemeral roles and stops before touching the engine. Reverting the
 * role check in settled-worktree.ts turns these red.
 */
describe('unsettleTab permanence', () => {
  const roles = ['bench-conversation', 'conflict-auto-fix', 'verification-analysis'] as const

  function settledTab(id: string, tabRole: string | null): TabState {
    return { id, workingDirectory: '/repo', tabRole, settledAt: 1, worktree: null } as unknown as TabState
  }

  for (const role of roles) {
    it(`refuses a settled ${role}`, async () => {
      const { slice } = harness([settledTab('rec', role)], [])
      await expect(slice.unsettleTab?.('rec', 'user')).resolves.toBe(false)
    })
  }

  it('does not refuse an ordinary settled conversation on the role rule', async () => {
    // Both outcomes are `false` here (this harness has no engine bridge), so
    // the honest discriminator is whether the engine was REACHED. A role
    // refusal returns before it; an ordinary record gets that far.
    const ensureEngineSession = vi.fn(async () => ({ ok: false as const }))
    vi.stubGlobal('window', { ion: { ensureEngineSession } })
    try {
      const { slice } = harness([settledTab('plain', null)], [])
      await slice.unsettleTab?.('plain', 'user')
      expect(ensureEngineSession).toHaveBeenCalledOnce()

      ensureEngineSession.mockClear()
      const bench = harness([settledTab('bench', 'bench-conversation')], [])
      await bench.slice.unsettleTab?.('bench', 'user')
      expect(ensureEngineSession).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
