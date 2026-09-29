/**
 * iOS → worktree/bench commands whose verb is a session-store action.
 *
 * Open-or-focus, occupant pre-flight, tab closing, the sync pipeline's state
 * machine: these live in the store, which this server owns (ADR-033). The
 * handler used to broadcast each command on an `ion:remote-*` channel for
 * the desktop's owner renderer to execute, then answer. Once the store moved
 * here that renderer listener had nothing to listen to, the channels were
 * off the wire contract, and every one of these commands was silently
 * dropped. The store is in this process, so the handler calls it and
 * answers the phone itself with a typed `desktop_worktree_op_result`.
 */
import type { useSessionStore as SessionStore } from '../../store/sessionStore'
import { isValidProjectPath } from '../../ipc-validation'
import { log as _log, warn as _warn } from '../../logger'
import type { RemoteCommand, RemoteEvent } from '../protocol'
import { sendRemoteEvent } from '../../thin-view/remote-out'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('remote-worktree-store', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('remote-worktree-store', msg, fields)
}

type OpResult = Extract<RemoteEvent, { type: 'desktop_worktree_op_result' }>
type Operation = OpResult['operation']

function sendOpResult(operation: Operation, result: Omit<OpResult, 'type' | 'operation'>): void {
  sendRemoteEvent({ type: 'desktop_worktree_op_result', operation, ...result })
}

function sendOpenResult(tabId: string | null, unavailableMessage: string): void {
  sendOpResult('open', { ok: tabId !== null, tabId: tabId ?? undefined, error: tabId === null ? unavailableMessage : undefined })
}

type PipelineState = ReturnType<typeof SessionStore.getState>['worktreePipeline']

/**
 * The store is loaded on first use, not at import: the handler module is
 * imported by boot and by tests that mock only the handler's own
 * collaborators, and the store's import graph reaches most of the server.
 */
async function sessionStore(): Promise<typeof SessionStore> {
  return (await import('../../store/sessionStore')).useSessionStore
}

/** The live pipeline as `desktop_worktree_pipeline`; a null pipeline is the dismissal shape so iOS clears its banner. */
export function projectPipelineToWire(p: PipelineState, lastRepoPath?: string): Extract<RemoteEvent, { type: 'desktop_worktree_pipeline' }> {
  if (!p) {
    return { type: 'desktop_worktree_pipeline', repoPath: lastRepoPath ?? '', sourceBranch: null, phase: null, queue: [], current: null, needsManual: [], resolvedByAi: 0 }
  }
  return {
    type: 'desktop_worktree_pipeline',
    repoPath: p.repoPath,
    sourceBranch: p.sourceBranch,
    phase: p.phase,
    queue: p.queue,
    current: p.current,
    needsManual: p.needsManual,
    resolvedByAi: p.resolvedByAi,
    summary: p.summary,
  }
}

let pipelineProjectionInstalled = false

/**
 * Mirror every pipeline phase/progress change onto the wire so iOS renders
 * the banner (and the AI-confirm gate) the desktop panel shows. The last
 * repoPath is retained so the dismissal (pipeline → null) still names which
 * repo's banner to clear. Call once at boot; idempotent.
 */
export async function wireWorktreePipelineProjection(): Promise<void> {
  if (pipelineProjectionInstalled) return
  pipelineProjectionInstalled = true
  let lastRepoPath = ''
  ;(await sessionStore()).subscribe((next, prev) => {
    if (next.worktreePipeline === prev.worktreePipeline) return
    if (next.worktreePipeline) lastRepoPath = next.worktreePipeline.repoPath
    sendRemoteEvent(projectPipelineToWire(next.worktreePipeline, lastRepoPath))
  })
  log('worktree pipeline projection wired')
}

/** TEST ONLY. */
export function _resetPipelineProjectionForTest(): void {
  pipelineProjectionInstalled = false
}

/**
 * Handle one store-backed worktree/bench command. Returns false for a
 * command this module does not own so the caller's switch continues.
 */
export async function handleWorktreeStoreCommand(cmd: RemoteCommand): Promise<boolean> {
  const store = (await sessionStore()).getState()
  switch (cmd.type) {
    case 'desktop_worktree_open_conversation': {
      // Two verbs, one command. Open-or-cycle is the default; the explicit
      // "new conversation" path skips the duplicate check because a SECOND
      // conversation in the same worktree is precisely what was asked for.
      log('open worktree conversation', { worktree_path: cmd.worktreePath, new_conversation: !!cmd.newConversation })
      try {
        const tabId = cmd.newConversation ? await store.newWorktreeConversation(cmd.worktreePath) : await store.openWorktreeConversation(cmd.worktreePath)
        sendOpResult('open', { ok: true, tabId })
      } catch (err) {
        warn('open worktree conversation failed', { worktree_path: cmd.worktreePath, error: String(err) })
        sendOpResult('open', { ok: false, error: String(err) })
      }
      return true
    }

    case 'desktop_bench_reorder_member': {
      // The store's `benchSetOrder` is the one reorder: it writes the order
      // and applies the returned workspace to the bench state every Studio
      // client mirrors. Writing the order behind the store's back left that
      // state showing the old order until its next refresh.
      if (!isValidProjectPath(cmd.worktreePath) || !isValidProjectPath(cmd.repoPath)) {
        warn('reorder member refused: invalid path', { worktree_path: cmd.worktreePath })
        return true
      }
      try {
        await store.benchSetOrder(cmd.repoPath, cmd.sourceBranch, cmd.worktreePath, cmd.toIndex)
        log('bench member reordered', { worktree_path: cmd.worktreePath, to_index: cmd.toIndex })
      } catch (err) {
        warn('reorder member failed', { worktree_path: cmd.worktreePath, error: String(err) })
      }
      // Loaded on use: `worktree.ts` imports this module.
      const { pushWorktreeState } = await import('./worktree')
      await pushWorktreeState(cmd.repoPath)
      return true
    }

    case 'desktop_worktree_create': {
      if (!isValidProjectPath(cmd.repoPath)) { sendOpResult('create', { ok: false, error: 'Invalid path.' }); return true }
      await run('create', async () => { const r = await store.createWorktree(cmd.repoPath, cmd.sourceBranch); return { ok: r.ok, error: r.error } })
      return true
    }

    case 'desktop_worktree_convert_conversation':
      await run('convert', () => store.convertToWorktree(cmd.tabId))
      return true

    case 'desktop_worktree_rename': {
      if (!isValidProjectPath(cmd.repoPath) || !isValidProjectPath(cmd.worktreePath)) { sendOpResult('rename', { ok: false, error: 'Invalid path.' }); return true }
      await run('rename', () => store.renameWorktree(cmd.repoPath, cmd.worktreePath, cmd.title))
      return true
    }

    case 'desktop_worktree_reprovision': {
      if (!isValidProjectPath(cmd.repoPath) || !isValidProjectPath(cmd.worktreePath)) { sendOpResult('reprovision', { ok: false, error: 'Invalid path.' }); return true }
      await run('reprovision', () => store.reprovisionWorktree(cmd.repoPath, cmd.worktreePath))
      return true
    }

    case 'desktop_worktree_retire': {
      // Dirty-work appraisal, occupant pre-flight and tab relocation all live
      // in the store's retire path.
      if (!isValidProjectPath(cmd.repoPath) || !isValidProjectPath(cmd.worktreePath)) {
        warn('retire refused: invalid path', { worktree_path: cmd.worktreePath })
        sendOpResult('retire', { ok: false, error: 'Invalid path.' })
        return true
      }
      log('retire worktree requested remotely', { worktree_path: cmd.worktreePath })
      await run('retire', async () => {
        const r = await store.retireWorktree(cmd.repoPath, cmd.worktreePath, cmd.branchName)
        return { ok: r.ok, error: r.error, recoveryRef: r.recoveryRef, prunedBenchPaths: r.prunedBenchPaths }
      })
      return true
    }

    case 'desktop_worktree_retire_landed': {
      // The bulk verb answers with a count rather than a per-worktree result:
      // the batch either finishes (`ok`) or stops at the first failure
      // (`!ok`, `retired` says how many were already removed).
      if (!isValidProjectPath(cmd.repoPath)) {
        warn('retire landed refused: invalid path', { repo_path: cmd.repoPath })
        sendOpResult('retire_all', { ok: false, error: 'Invalid path.' })
        return true
      }
      log('retire all landed worktrees requested remotely', { repo_path: cmd.repoPath })
      await run('retire_all', async () => {
        const r = await store.retireLandedWorktrees(cmd.repoPath)
        return { ok: r.ok, error: r.error, retired: r.retired }
      })
      return true
    }

    case 'desktop_worktree_conflict_assist': {
      // The desktop ConflictsDialog's "AI Assisted" verb: one fresh auto-mode
      // resolver conversation in the conflicted worktree. openConflictAssist
      // dedupes per directory, so a repeat tap focuses the running resolver.
      if (!isValidProjectPath(cmd.repoPath) || !isValidProjectPath(cmd.worktreePath)) {
        warn('conflict assist refused: invalid path', { worktree_path: cmd.worktreePath })
        sendOpResult('conflict_assist', { ok: false, error: 'Invalid path.' })
        return true
      }
      log('worktree conflict assist requested remotely', { worktree_path: cmd.worktreePath })
      await run('conflict_assist', async () => ({ ok: true, tabId: await store.openConflictAssist(cmd.worktreePath) }))
      return true
    }

    case 'desktop_bench_conflict_assist': {
      // Chain: recreate the failed assembly merge in the bench (or reassemble
      // outright when recordings already cover it), then launch the assisted
      // resolver on the bench directory.
      if (!isValidProjectPath(cmd.repoPath)) { sendOpResult('conflict_assist', { ok: false, error: 'Invalid path.' }); return true }
      log('bench conflict assist requested remotely', { source_branch: cmd.sourceBranch })
      await run('conflict_assist', async () => {
        const benchPath = await store.benchResolveConflict(cmd.repoPath, cmd.sourceBranch)
        if (!benchPath) return { ok: true }
        return { ok: true, tabId: await store.openConflictAssist(benchPath) }
      })
      return true
    }

    case 'desktop_bench_recover_conflict':
      await run('recover_conflict', async () => { await store.benchResolveConflict(cmd.repoPath, cmd.sourceBranch); return { ok: true } })
      return true

    case 'desktop_bench_analyse_verification':
      await run('analyse_verification', async () => ({ ok: true, tabId: await store.openBenchVerificationAnalysis(cmd.repoPath, cmd.sourceBranch) }))
      return true

    case 'desktop_bench_discard_member_recordings':
      await run('discard_recordings', async () => {
        const r = await store.benchDiscardMemberRecordings(cmd.repoPath, cmd.sourceBranch, cmd.branchNames)
        return { ok: r.ok, error: r.error }
      })
      return true

    case 'desktop_bench_discard_all_recordings':
      await run('discard_recordings', async () => {
        const workspace = (store.benchWorkspaces.get(cmd.repoPath) ?? []).find((item) => item.sourceBranch === cmd.sourceBranch)
        if (!workspace) throw new Error('No integration workspace for this source branch.')
        await store.benchRerereDiscardAll(workspace.benchPath)
        await store.refreshBench(cmd.repoPath)
        return { ok: true }
      })
      return true

    case 'desktop_bench_open_conversation':
      log('open bench conversation', { source_branch: cmd.sourceBranch })
      try {
        sendOpenResult(await store.openBenchConversation(cmd.repoPath, cmd.sourceBranch), 'Could not open bench conversation.')
      } catch (err) {
        warn('open bench conversation failed', { error: String(err) })
        sendOpResult('open', { ok: false, error: String(err) })
      }
      return true

    case 'desktop_bench_open_terminal':
      // A shell in the bench rather than a conversation about it; the store
      // owns the one-terminal-per-bench decision.
      log('open bench terminal', { source_branch: cmd.sourceBranch })
      try {
        sendOpenResult(await store.openBenchTerminal(cmd.repoPath, cmd.sourceBranch), 'Could not open bench terminal.')
      } catch (err) {
        warn('open bench terminal failed', { error: String(err) })
        sendOpResult('open', { ok: false, error: String(err) })
      }
      return true

    case 'desktop_worktree_pipeline_start': {
      // Start acknowledges with a pipeline_start result (started, or refused
      // because one is running); every phase change reaches iOS through the
      // projection wired at boot.
      if (!isValidProjectPath(cmd.repoPath)) { sendOpResult('pipeline_start', { ok: false, error: 'Invalid path.' }); return true }
      const existing = store.worktreePipeline
      if (existing && existing.phase !== 'done' && existing.phase !== 'failed') {
        sendOpResult('pipeline_start', { ok: false, error: 'A sync pipeline is already running.' })
        return true
      }
      log('worktree pipeline start requested remotely', { repo_path: cmd.repoPath, source_branch: cmd.sourceBranch })
      sendOpResult('pipeline_start', { ok: true })
      store.startWorktreePipeline(cmd.repoPath, cmd.sourceBranch ?? null).catch((err) => warn('pipeline start failed', { repo_path: cmd.repoPath, error: String(err) }))
      return true
    }

    case 'desktop_worktree_pipeline_confirm_ai':
      log('worktree pipeline AI escalation confirmed remotely', { repo_path: cmd.repoPath })
      store.confirmWorktreePipelineAi().catch((err) => warn('pipeline AI confirm failed', { repo_path: cmd.repoPath, error: String(err) }))
      return true

    case 'desktop_worktree_pipeline_cancel':
      log('worktree pipeline cancel requested remotely', { repo_path: cmd.repoPath })
      store.cancelWorktreePipeline()
      return true

    case 'desktop_worktree_pipeline_dismiss':
      store.dismissWorktreePipeline()
      return true

    default:
      return false
  }
}

/** Run one store verb and answer the phone with its result, or the failure, under `operation`. */
async function run(operation: Operation, verb: () => Promise<Omit<OpResult, 'type' | 'operation'>>): Promise<void> {
  try {
    sendOpResult(operation, await verb())
  } catch (err) {
    warn('worktree action failed', { operation, error: String(err) })
    sendOpResult(operation, { ok: false, error: String(err) })
  }
}
