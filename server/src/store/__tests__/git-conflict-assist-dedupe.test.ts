/**
 * openConflictAssist deduplication — per-directory in-flight coalescence.
 *
 * Split from git-conflict-slice.test.ts for the file-size cap.
 * Same harness pattern, narrower scope: only the dedup and reuse paths.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

const preferenceState = { aiGeneratedTitles: false, aiAssistPromptOverrides: {} as Record<string, string> }
vi.mock('../../persistence/preferences', () => ({
  usePreferencesStore: { getState: () => preferenceState },
}))

const applyPermissionModeForTab = vi.fn()
vi.mock('../slices/tab-slice-permission-mode', () => ({
  applyPermissionModeForTab: (...args: any[]) => applyPermissionModeForTab(...args),
}))

// `resolveWorkbenchTier` (called by `openConflictAssistInner` before
// `gitOpState`) resolves through `host-api.ts`'s `resolveModelTier`, which
// since the desktop-main-process-into-@ion/server move calls the real
// `engineBridge` directly -- `window.ion.resolveModelTier` (this file's
// `ionWith()` below) is a pre-migration vestige nothing in this call path
// reads anymore. Without this mock the real `engineBridge` tries to connect
// to whatever this process's `ION_DATA_DIR/engine.sock` happens to be, which
// only ever "worked" by accident on a machine with a real Ion Engine daemon
// already running at that path. Matches the sibling split
// `git-conflict-slice.test.ts`'s `vi.mock('../host-api', ...)` pattern.
const gitOpState = vi.fn().mockResolvedValue({ ok: true, state: null, branch: null, onto: null })
const resolveModelTier = vi.fn().mockResolvedValue({
  tier: CONFLICT_ASSIST_TIER,
  model: 'prov/fast',
  fallbacks: [],
  configured: true,
})
vi.mock('../host-api', () => ({
  echoUserTurnToStudio: vi.fn(),
  gitOpState: (...args: any[]) => gitOpState(...args),
  resolveModelTier: (...args: any[]) => resolveModelTier(...args),
}))

import { createGitConflictSlice } from '../slices/git-conflict-slice'
import { CONFLICT_ASSIST_TIER } from '@ion/shared/types-model-tiers'
import { createWorktreeInventorySlice } from '../slices/worktree-inventory-slice'
import { clearInflight } from '../slices/conflict-assist-dedupe'
import type { State, GitConflictAlert } from '../session-store-types'

const WT = '/home/dev/.ion/worktrees/proj-a1'

function harness(extra: Record<string, unknown> = {}): {
  slice: Partial<State>
  state: () => Record<string, unknown>
} {
  let state: Record<string, unknown> = {
    gitConflictAlerts: new Map<string, GitConflictAlert>(),
    worktreeInventory: new Map(),
    benchWorkspaces: new Map(),
    tabs: [],
    activeTabId: null,
    ...extra,
  }
  const set = (fn: (s: Record<string, unknown>) => Record<string, unknown>): void => {
    state = { ...state, ...fn(state) }
  }
  const get = (): Record<string, unknown> => state
  const slice = {
    ...createGitConflictSlice(
      set as unknown as Parameters<typeof createGitConflictSlice>[0],
      get as unknown as Parameters<typeof createGitConflictSlice>[1],
    ),
    ...createWorktreeInventorySlice(
      set as unknown as Parameters<typeof createWorktreeInventorySlice>[0],
      get as unknown as Parameters<typeof createWorktreeInventorySlice>[1],
    ),
  } as Partial<State>
  state = { ...state, ...slice, ...extra }
  return { slice, state: () => state }
}

function ionWith(): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    ion: {
      resolveModelTier: vi.fn(async () => ({
        tier: CONFLICT_ASSIST_TIER, model: 'prov/fast', fallbacks: [], configured: true,
      })),
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  preferenceState.aiAssistPromptOverrides = {}
  clearInflight(WT)
  clearInflight('/bench/other')
})

describe('openConflictAssist — deduplication', () => {
  it('reuses an existing auto-fix tab for the same directory instead of creating a new one', async () => {
    ionWith()
    const selectTab = vi.fn()
    const createTabInDirectory = vi.fn().mockResolvedValue('tab-new')
    const h = harness({
      submit: vi.fn(), selectTab, setTabAutomaticModel: vi.fn(), createTabInDirectory,
      tabs: [{ id: 'tab-existing', tabRole: 'conflict-auto-fix', workingDirectory: WT }],
    })

    const tabId = await h.slice.openConflictAssist!(WT)

    expect(tabId).toBe('tab-existing')
    expect(selectTab).toHaveBeenCalledWith('tab-existing')
    expect(createTabInDirectory).not.toHaveBeenCalled()
  })

  it('creates a new tab when the existing auto-fix tab is for a different directory', async () => {
    ionWith()
    const selectTab = vi.fn()
    const createTabInDirectory = vi.fn().mockResolvedValue('tab-new')
    const h = harness({
      submit: vi.fn(), selectTab, setTabAutomaticModel: vi.fn(), createTabInDirectory,
      tabs: [{ id: 'tab-other', tabRole: 'conflict-auto-fix', workingDirectory: '/bench/other' }],
    })

    const tabId = await h.slice.openConflictAssist!(WT)

    expect(tabId).toBe('tab-new')
    expect(selectTab).not.toHaveBeenCalled()
    expect(createTabInDirectory).toHaveBeenCalledWith(WT, false, true)
  })

  it('concurrent calls for the same directory share one promise', async () => {
    ionWith()
    let resolveCreate!: (id: string) => void
    const createTabInDirectory = vi.fn(() => new Promise<string>((r) => { resolveCreate = r }))
    const h = harness({
      submit: vi.fn(), setTabAutomaticModel: vi.fn(), createTabInDirectory,
      tabs: [{ id: 'tab-new', inputLocked: false }],
    })

    const p1 = h.slice.openConflictAssist!(WT)
    await vi.waitFor(() => expect(createTabInDirectory).toHaveBeenCalledTimes(1))

    const p2 = h.slice.openConflictAssist!(WT)

    resolveCreate('tab-new')
    const [id1, id2] = await Promise.all([p1, p2])
    expect(id1).toBe('tab-new')
    expect(id2).toBe('tab-new')
    expect(createTabInDirectory).toHaveBeenCalledTimes(1)
  })

  it('clears inflight after creation completes, allowing a later call to proceed', async () => {
    ionWith()
    const createTabInDirectory = vi.fn().mockResolvedValue('tab-1')
    const h = harness({
      submit: vi.fn(), setTabAutomaticModel: vi.fn(), createTabInDirectory,
      tabs: [{ id: 'tab-1', inputLocked: false }],
    })

    await h.slice.openConflictAssist!(WT)

    createTabInDirectory.mockResolvedValue('tab-2')
    ;(h.state() as { tabs: Array<{ id: string; inputLocked: boolean }> }).tabs.push(
      { id: 'tab-2', inputLocked: false },
    )
    await h.slice.openConflictAssist!(WT)
    expect(createTabInDirectory).toHaveBeenCalledTimes(2)
  })
})
