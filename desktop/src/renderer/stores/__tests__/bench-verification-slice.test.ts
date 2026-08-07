/**
 * bench-verification-slice — the AI-assisted ANALYSIS flow.
 *
 * Modelled on git-conflict-slice.test.ts's openConflictAssist harness, with
 * the one assertion that matters for the divergence this slice makes on
 * purpose: PLAN mode, not auto — the deliverable is a verdict, never a fix.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ aiAssistPromptOverrides: {} }) },
}))

const applyPermissionModeForTab = vi.fn()
vi.mock('../slices/tab-slice-permission-mode', () => ({
  applyPermissionModeForTab: (...args: unknown[]) => applyPermissionModeForTab(...args),
}))

import { createBenchVerificationSlice } from '../slices/bench-verification-slice'
import { CONFLICT_ASSIST_TIER } from '../../../shared/types-model-tiers'
import type { State } from '../session-store-types'
import type { IntegrationWorkspace } from '../../../shared/types'

const REPO = '/repo'
const BRANCH = 'josh'
const BENCH_PATH = '/bench'

function workspaceFixture(over: Partial<IntegrationWorkspace> = {}): IntegrationWorkspace {
  return {
    repoPath: REPO,
    sourceBranch: BRANCH,
    benchPath: BENCH_PATH,
    benchBranch: 'ion/bench/josh',
    members: [
      {
        worktreePath: '/wt/a',
        branchName: 'wt/a',
        enabled: true,
        pin: 'current',
        merge: 'unbuilt',
        pinnedSha: 'abc1234',
        pinnedTreeHash: 't1',
        pinnedBaseSha: 'b1',
        currentTreeHash: 't1',
      },
    ],
    baseSha: 'base1234',
    lastBuiltAt: Date.now(),
    ...over,
  }
}

interface Harness {
  slice: Partial<State>
  state: () => Record<string, unknown>
}

function harness(extra: Record<string, unknown> = {}): Harness {
  let state: Record<string, unknown> = {
    benchWorkspaces: new Map([[REPO, [workspaceFixture()]]]),
    tabs: [],
    activeTabId: null,
    refreshBench: vi.fn().mockResolvedValue(undefined),
    ...extra,
  }
  const set = (fn: (s: Record<string, unknown>) => Record<string, unknown>): void => {
    state = { ...state, ...fn(state) }
  }
  const get = (): Record<string, unknown> => state
  const slice = createBenchVerificationSlice(
    set as unknown as Parameters<typeof createBenchVerificationSlice>[0],
    get as unknown as Parameters<typeof createBenchVerificationSlice>[1],
  ) as Partial<State>
  state = { ...state, ...slice, ...extra }
  return { slice, state: () => state }
}

/** window.ion with a configured standard tier, overridable per test. */
function ionWith(over: Partial<{
  configured: boolean
  model: string
  prepareOk: boolean
  prepareBenchPath: string
  prepareError: string
}> = {}): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    ion: {
      resolveModelTier: vi.fn().mockResolvedValue({
        tier: CONFLICT_ASSIST_TIER,
        model: over.model ?? 'prov/claude-sonnet-4-6',
        fallbacks: [],
        configured: over.configured ?? true,
      }),
      benchPrepareVerificationAnalysis: vi.fn().mockResolvedValue(
        over.prepareOk === false
          ? { ok: false, error: over.prepareError ?? 'state changed' }
          : { ok: true, benchPath: over.prepareBenchPath ?? BENCH_PATH },
      ),
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('openBenchVerificationAnalysis', () => {
  it('refuses with a remediation message when the standard tier is not configured, creating no tab', async () => {
    ionWith({ configured: false })
    const createTabInDirectory = vi.fn()
    const h = harness({ createTabInDirectory })

    await expect(h.slice.openBenchVerificationAnalysis!(REPO, BRANCH)).rejects.toThrow(/workbench-sync.*standard.*Settings/s)
    expect(createTabInDirectory).not.toHaveBeenCalled()
  })

  it('refuses and creates no tab when the diagnostic tree cannot be rebuilt', async () => {
    ionWith({ prepareOk: false, prepareError: 'wt/a no longer merges the same way' })
    const createTabInDirectory = vi.fn()
    const h = harness({ createTabInDirectory })

    await expect(h.slice.openBenchVerificationAnalysis!(REPO, BRANCH))
      .rejects.toThrow('wt/a no longer merges the same way')
    expect(createTabInDirectory).not.toHaveBeenCalled()
  })

  it('materialises the diagnostic tree, opens a PLAN-mode locked tab, and submits the analysis prompt', async () => {
    ionWith()
    const submit = vi.fn()
    const setTabModel = vi.fn()
    const createTabInDirectory = vi.fn().mockResolvedValue('tab-analysis')
    const refreshedWorkspace = workspaceFixture({
      lastAssemblyFailure: 'verification',
      lastAssemblyVerification: {
        command: 'npm run typecheck',
        outputTail: 'error TS1109: Expression expected.',
        replayedBranches: ['wt/a'],
      },
    })
    const refreshBench = vi.fn().mockImplementation(async () => {
      state.benchWorkspaces = new Map([[REPO, [refreshedWorkspace]]])
    })
    const h = harness({
      submit, setTabModel, createTabInDirectory,
      refreshBench: (...a: unknown[]) => refreshBench(...a),
      // The store's role/lock tagging maps over the EXISTING tabs array by id
      // (see git-conflict-slice.ts's set() call) — the harness must already
      // carry the tab createTabInDirectory "returns" for that map to find it.
      tabs: [{ id: 'tab-analysis', inputLocked: false }],
    })
    const state = h.state()

    const tabId = await h.slice.openBenchVerificationAnalysis!(REPO, BRANCH)

    expect(tabId).toBe('tab-analysis')
    expect(createTabInDirectory).toHaveBeenCalledWith(BENCH_PATH, false, true)
    expect(setTabModel).toHaveBeenCalledWith('tab-analysis', 'prov/claude-sonnet-4-6')

    // The one deliberate divergence from openConflictAssist: PLAN, not auto.
    expect(applyPermissionModeForTab).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'tab-analysis', 'plan', 'bench_verification_analysis',
    )

    const finalState = h.state()
    const tab = (finalState.tabs as { id: string; tabRole?: string; inputLocked?: boolean }[])
      .find((t) => t.id === 'tab-analysis')
    expect(tab?.tabRole).toBe('verification-analysis')
    expect(tab?.inputLocked).toBe(true)

    expect(submit).toHaveBeenCalledTimes(1)
    const [calledTabId, prompt, opts] = submit.mock.calls[0]
    expect(calledTabId).toBe('tab-analysis')
    expect(opts).toEqual({ source: 'machine' })
    expect(prompt).toContain('npm run typecheck')
    expect(prompt).toContain('error TS1109')
    expect(prompt).toContain('wt/a')
  })
})
