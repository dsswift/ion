/**
 * Worktree/bench commands reach the store this server owns and answer the
 * client with a typed op result. Before this module the handler broadcast
 * each command for a renderer listener that no longer existed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => {
  const listeners: Array<(next: unknown, prev: unknown) => void> = []
  const store: Record<string, unknown> = {
    worktreePipeline: null,
    benchWorkspaces: new Map(),
    newWorktreeConversation: vi.fn(async () => 'tab-new'),
    openWorktreeConversation: vi.fn(async () => 'tab-open'),
    createWorktree: vi.fn(async () => ({ ok: true })),
    convertToWorktree: vi.fn(async () => ({ ok: true, tabId: 't' })),
    renameWorktree: vi.fn(async () => ({ ok: true })),
    reprovisionWorktree: vi.fn(async () => ({ ok: true })),
    retireWorktree: vi.fn(async () => ({ ok: true, recoveryRef: 'ref', prunedBenchPaths: ['/b'] })),
    retireLandedWorktrees: vi.fn(async () => ({ ok: false, error: 'stopped', retired: 2 })),
    openConflictAssist: vi.fn(async () => 'tab-assist'),
    benchResolveConflict: vi.fn(async () => '/bench'),
    benchSetOrder: vi.fn(async () => undefined),
    openBenchVerificationAnalysis: vi.fn(async () => 'tab-verify'),
    benchDiscardMemberRecordings: vi.fn(async () => ({ ok: true })),
    benchRerereDiscardAll: vi.fn(async () => undefined),
    refreshBench: vi.fn(async () => undefined),
    openBenchConversation: vi.fn(async () => null),
    openBenchTerminal: vi.fn(async () => 'tab-term'),
    startWorktreePipeline: vi.fn(async () => undefined),
    confirmWorktreePipelineAi: vi.fn(async () => undefined),
    cancelWorktreePipeline: vi.fn(),
    dismissWorktreePipeline: vi.fn(),
  }
  return {
    store,
    listeners,
    useSessionStore: { getState: () => store, subscribe: (cb: (next: unknown, prev: unknown) => void) => { listeners.push(cb); return () => undefined } },
    send: vi.fn(),
    pushWorktreeState: vi.fn(async () => undefined),
    sendRemoteEvent: vi.fn(),
  }
})
vi.mock('../../../store/sessionStore', () => ({ useSessionStore: deps.useSessionStore }))
vi.mock('../../../state', () => ({ state: {} }))
vi.mock('../../../thin-view/remote-out', () => ({ sendRemoteEvent: deps.sendRemoteEvent }))
vi.mock('../../../ipc-validation', () => ({ isValidProjectPath: (p: unknown) => typeof p === 'string' && p.startsWith('/') }))
vi.mock('../worktree', () => ({ pushWorktreeState: deps.pushWorktreeState }))
vi.mock('../../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { _resetPipelineProjectionForTest, handleWorktreeStoreCommand, projectPipelineToWire, wireWorktreePipelineProjection } from '../worktree-store-commands'
import type { RemoteCommand } from '../../protocol'

const sent = () => deps.sendRemoteEvent.mock.calls.map((c) => c[0])
const cmd = (c: Record<string, unknown>) => c as unknown as RemoteCommand

beforeEach(() => {
  deps.sendRemoteEvent.mockClear()
  deps.store.worktreePipeline = null
  ;(deps.store.benchWorkspaces as Map<string, unknown>).clear()
  for (const v of Object.values(deps.store)) if (typeof v === 'function') (v as ReturnType<typeof vi.fn>).mockClear()
  deps.listeners.length = 0
  _resetPipelineProjectionForTest()
})

describe('handleWorktreeStoreCommand', () => {
  it('reorders a bench member through the store, then pushes the refreshed state', async () => {
    deps.pushWorktreeState.mockClear()
    expect(await handleWorktreeStoreCommand(cmd({ type: 'desktop_bench_reorder_member', repoPath: '/repo', sourceBranch: 'main', worktreePath: '/wt', toIndex: 2 }))).toBe(true)
    expect(deps.store.benchSetOrder).toHaveBeenCalledWith('/repo', 'main', '/wt', 2)
    expect(deps.pushWorktreeState).toHaveBeenCalledWith('/repo')
  })

  it('refuses a reorder that names a path outside a project', async () => {
    deps.pushWorktreeState.mockClear()
    await handleWorktreeStoreCommand(cmd({ type: 'desktop_bench_reorder_member', repoPath: 'relative', sourceBranch: 'main', worktreePath: '/wt', toIndex: 0 }))
    expect(deps.store.benchSetOrder).not.toHaveBeenCalled()
    expect(deps.pushWorktreeState).not.toHaveBeenCalled()
  })

  it('opens or creates a worktree conversation through the store and answers open', async () => {
    expect(await handleWorktreeStoreCommand(cmd({ type: 'desktop_worktree_open_conversation', worktreePath: '/wt' }))).toBe(true)
    expect(deps.store.openWorktreeConversation).toHaveBeenCalledWith('/wt')
    expect(sent()).toEqual([{ type: 'desktop_worktree_op_result', operation: 'open', ok: true, tabId: 'tab-open' }])
    await handleWorktreeStoreCommand(cmd({ type: 'desktop_worktree_open_conversation', worktreePath: '/wt', newConversation: true }))
    expect(deps.store.newWorktreeConversation).toHaveBeenCalledWith('/wt')
  })

  it('refuses an invalid path before touching the store', async () => {
    await handleWorktreeStoreCommand(cmd({ type: 'desktop_worktree_create', repoPath: 'relative', sourceBranch: 'main' }))
    expect(deps.store.createWorktree).not.toHaveBeenCalled()
    expect(sent()).toEqual([{ type: 'desktop_worktree_op_result', operation: 'create', ok: false, error: 'Invalid path.' }])
  })

  it('maps retire and retire-all results onto the wire, including the recovery ref, pruned benches and the count', async () => {
    await handleWorktreeStoreCommand(cmd({ type: 'desktop_worktree_retire', repoPath: '/r', worktreePath: '/wt', branchName: 'b' }))
    await handleWorktreeStoreCommand(cmd({ type: 'desktop_worktree_retire_landed', repoPath: '/r' }))
    expect(sent()).toEqual([
      { type: 'desktop_worktree_op_result', operation: 'retire', ok: true, error: undefined, recoveryRef: 'ref', prunedBenchPaths: ['/b'] },
      { type: 'desktop_worktree_op_result', operation: 'retire_all', ok: false, error: 'stopped', retired: 2 },
    ])
  })

  it('a thrown store verb answers the client as a failure under the same operation', async () => {
    ;(deps.store.renameWorktree as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('registry locked'))
    await handleWorktreeStoreCommand(cmd({ type: 'desktop_worktree_rename', repoPath: '/r', worktreePath: '/wt', title: 'x' }))
    expect(sent()).toEqual([{ type: 'desktop_worktree_op_result', operation: 'rename', ok: false, error: 'Error: registry locked' }])
  })

  it('the bench assist chain reassembles then launches the resolver; recordings covering everything means no resolver', async () => {
    await handleWorktreeStoreCommand(cmd({ type: 'desktop_bench_conflict_assist', repoPath: '/r', sourceBranch: 'main' }))
    expect(deps.store.openConflictAssist).toHaveBeenCalledWith('/bench')
    expect(sent()).toEqual([{ type: 'desktop_worktree_op_result', operation: 'conflict_assist', ok: true, tabId: 'tab-assist' }])
    ;(deps.store.benchResolveConflict as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    await handleWorktreeStoreCommand(cmd({ type: 'desktop_bench_conflict_assist', repoPath: '/r', sourceBranch: 'main' }))
    expect(sent()[1]).toEqual({ type: 'desktop_worktree_op_result', operation: 'conflict_assist', ok: true })
  })

  it('discard-all needs a known workspace; the bench opens answer with the tab or the unavailable message', async () => {
    await handleWorktreeStoreCommand(cmd({ type: 'desktop_bench_discard_all_recordings', repoPath: '/r', sourceBranch: 'main' }))
    expect(sent()[0]).toMatchObject({ operation: 'discard_recordings', ok: false })
    ;(deps.store.benchWorkspaces as Map<string, unknown>).set('/r', [{ sourceBranch: 'main', benchPath: '/bench' }])
    await handleWorktreeStoreCommand(cmd({ type: 'desktop_bench_discard_all_recordings', repoPath: '/r', sourceBranch: 'main' }))
    expect(deps.store.benchRerereDiscardAll).toHaveBeenCalledWith('/bench')
    expect(sent()[1]).toEqual({ type: 'desktop_worktree_op_result', operation: 'discard_recordings', ok: true })

    await handleWorktreeStoreCommand(cmd({ type: 'desktop_bench_open_conversation', repoPath: '/r', sourceBranch: 'main' }))
    expect(sent()[2]).toEqual({ type: 'desktop_worktree_op_result', operation: 'open', ok: false, tabId: undefined, error: 'Could not open bench conversation.' })
    await handleWorktreeStoreCommand(cmd({ type: 'desktop_bench_open_terminal', repoPath: '/r', sourceBranch: 'main' }))
    expect(sent()[3]).toEqual({ type: 'desktop_worktree_op_result', operation: 'open', ok: true, tabId: 'tab-term', error: undefined })
  })

  it('pipeline start is refused while one runs, otherwise acknowledged before the store starts it', async () => {
    deps.store.worktreePipeline = { phase: 'resolving' }
    await handleWorktreeStoreCommand(cmd({ type: 'desktop_worktree_pipeline_start', repoPath: '/r', sourceBranch: 'main' }))
    expect(sent()[0]).toMatchObject({ operation: 'pipeline_start', ok: false })
    expect(deps.store.startWorktreePipeline).not.toHaveBeenCalled()
    deps.store.worktreePipeline = { phase: 'done' }
    await handleWorktreeStoreCommand(cmd({ type: 'desktop_worktree_pipeline_start', repoPath: '/r', sourceBranch: 'main' }))
    expect(sent()[1]).toEqual({ type: 'desktop_worktree_op_result', operation: 'pipeline_start', ok: true })
    expect(deps.store.startWorktreePipeline).toHaveBeenCalledWith('/r', 'main')
    await handleWorktreeStoreCommand(cmd({ type: 'desktop_worktree_pipeline_cancel', repoPath: '/r' }))
    expect(deps.store.cancelWorktreePipeline).toHaveBeenCalled()
  })

  it('returns false for a command it does not own', async () => {
    expect(await handleWorktreeStoreCommand(cmd({ type: 'desktop_worktree_sync', repoPath: '/r', worktreePath: '/wt' }))).toBe(false)
    expect(sent()).toEqual([])
  })
})

describe('pipeline projection', () => {
  it('pushes every pipeline change to the client and the dismissal shape naming the last repo', async () => {
    await wireWorktreePipelineProjection()
    await wireWorktreePipelineProjection()
    expect(deps.listeners).toHaveLength(1)
    const running = { repoPath: '/r', sourceBranch: 'main', phase: 'syncing', queue: ['/a'], current: null, needsManual: [], resolvedByAi: 0 }
    deps.listeners[0]({ worktreePipeline: running }, { worktreePipeline: null })
    deps.listeners[0]({ worktreePipeline: running }, { worktreePipeline: running })
    deps.listeners[0]({ worktreePipeline: null }, { worktreePipeline: running })
    expect(sent()).toEqual([
      projectPipelineToWire(running as never),
      { type: 'desktop_worktree_pipeline', repoPath: '/r', sourceBranch: null, phase: null, queue: [], current: null, needsManual: [], resolvedByAi: 0 },
    ])
  })
})
