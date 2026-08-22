import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { rError } from '../rendererLogger'

/**
 * iOS → desktop worktree/bench remote commands, kept outside App so app
 * composition stays within the file-size cap.
 *
 * These are distinct from `useWorktreeRendererListeners`: that hook reacts to
 * MAIN-originated broadcasts (a worktree titled, a worktree landed); this one
 * answers commands relayed from iOS, which the desktop owner renderer executes
 * because the store actions (open-or-focus, occupant pre-flight, tab closing)
 * live here, not in main. Every arm answers with `sendRemote` so iOS gets a
 * typed `desktop_worktree_op_result` rather than silence.
 */
function sendOpenResult(tabId: string | null, unavailableMessage: string): void {
  window.ion.sendRemote({
    type: 'desktop_worktree_op_result',
    operation: 'open',
    ok: tabId !== null,
    tabId: tabId ?? undefined,
    error: tabId === null ? unavailableMessage : undefined,
  })
}

export { sendOpenResult }

/**
 * Push the live pipeline state onto the wire as `desktop_worktree_pipeline`.
 * Exported for the subscription below and for tests. A null pipeline sends the
 * dismissal shape (phase: null) so iOS clears its banner.
 */
export function projectPipelineToWire(p: {
  repoPath: string
  sourceBranch: string | null
  phase: 'syncing' | 'awaiting-ai-confirm' | 'resolving' | 'assembling' | 'done' | 'failed'
  queue: string[]
  current: string | null
  needsManual: string[]
  resolvedByAi: number
  summary?: string
} | null, lastRepoPath?: string): Record<string, unknown> {
  if (!p) {
    return {
      type: 'desktop_worktree_pipeline',
      repoPath: lastRepoPath ?? '',
      sourceBranch: null,
      phase: null,
      queue: [],
      current: null,
      needsManual: [],
      resolvedByAi: 0,
    }
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

export function useWorktreeRemoteCommandListeners(): void {
  // iOS asked to open a conversation in a worktree or the bench. The store
  // actions own the open-or-focus decision, so both clients behave identically.
  useEffect(() => {
    return window.ion.onRemoteOpenWorktreeConversation(({ worktreePath, newConversation }) => {
      const store = useSessionStore.getState()
      // Two verbs, one command. Open-or-cycle is the default; the explicit
      // "new conversation" path skips the duplicate check because a SECOND
      // conversation in the same worktree is precisely what was asked for.
      const opened = newConversation
        ? store.newWorktreeConversation(worktreePath)
        : store.openWorktreeConversation(worktreePath)
      void opened.then((tabId) => {
        window.ion.sendRemote({
          type: 'desktop_worktree_op_result',
          operation: 'open',
          ok: true,
          tabId,
        })
      }).catch((err) => {
        rError('remote', 'open worktree conversation failed', {
          error: String(err), new_conversation: String(!!newConversation),
        })
        window.ion.sendRemote({
          type: 'desktop_worktree_op_result',
          operation: 'open',
          ok: false,
          error: String(err),
        })
      })
    })
  }, [])

  useEffect(() => {
    return window.ion.onRemoteOpenBenchConversation(({ repoPath, sourceBranch }) => {
      void useSessionStore.getState().openBenchConversation(repoPath, sourceBranch)
        .then((tabId) => sendOpenResult(tabId, 'Could not open bench conversation.'))
        .catch((err) => {
          rError('remote', 'open bench conversation failed', { error: String(err) })
          window.ion.sendRemote({
            type: 'desktop_worktree_op_result',
            operation: 'open',
            ok: false,
            error: String(err),
          })
        })
    })
  }, [])

  useEffect(() => {
    return window.ion.onRemoteRetireWorktree(({ repoPath, worktreePath, branchName }) => {
      void (async () => {
        const result = await useSessionStore.getState().retireWorktree(repoPath, worktreePath, branchName)
        window.ion.sendRemote({
          type: 'desktop_worktree_op_result',
          operation: 'retire',
          ok: result.ok,
          error: result.error,
          recoveryRef: result.recoveryRef,
          prunedBenchPaths: result.prunedBenchPaths,
        })
      })().catch((err) => rError('remote', 'retire worktree failed', {
        worktree_path: worktreePath,
        error: String(err),
      }))
    })
  }, [])

  // iOS's bulk "Retire all landed" — mirrors the desktop's own confirmed batch
  // verb. Answers with a count rather than a per-worktree result: the batch
  // either finishes (`ok`, every landed worktree gone) or stops at the first
  // failure (`!ok`, `retired` says how many were already removed).
  useEffect(() => {
    return window.ion.onRemoteRetireLandedWorktrees(({ repoPath }) => {
      void (async () => {
        const result = await useSessionStore.getState().retireLandedWorktrees(repoPath)
        window.ion.sendRemote({
          type: 'desktop_worktree_op_result',
          operation: 'retire_all',
          ok: result.ok,
          error: result.error,
          retired: result.retired,
        })
      })().catch((err) => rError('remote', 'retire landed worktrees failed', {
        repo_path: repoPath,
        error: String(err),
      }))
    })
  }, [])

  useEffect(() => {
    return window.ion.onRemoteWorktreeAction((action, arg) => {
      const store = useSessionStore.getState()
      const repoPath = typeof arg.repoPath === 'string' ? arg.repoPath : ''
      const sourceBranch = typeof arg.sourceBranch === 'string' ? arg.sourceBranch : ''
      const worktreePath = typeof arg.worktreePath === 'string' ? arg.worktreePath : ''
      const send = (operation: string, result: { ok: boolean; error?: string; tabId?: string }) => {
        window.ion.sendRemote({ type: 'desktop_worktree_op_result', operation, ...result })
      }
      const run = async (): Promise<void> => {
        switch (action) {
          case 'ion:remote-create-worktree': {
            const result = await store.createWorktree(repoPath, sourceBranch)
            send('create', { ok: result.ok, error: result.error })
            return
          }
          case 'ion:remote-convert-worktree-conversation': {
            const tabId = typeof arg.tabId === 'string' ? arg.tabId : ''
            const result = await store.convertToWorktree(tabId)
            send('convert', result)
            return
          }
          case 'ion:remote-rename-worktree': {
            const title = typeof arg.title === 'string' ? arg.title : ''
            const result = await store.renameWorktree(repoPath, worktreePath, title)
            send('rename', result)
            return
          }
          case 'ion:remote-reprovision-worktree': {
            const result = await store.reprovisionWorktree(repoPath, worktreePath)
            send('reprovision', result)
            return
          }
          case 'ion:remote-recover-bench-conflict': {
            await store.benchResolveConflict(repoPath, sourceBranch)
            send('recover_conflict', { ok: true })
            return
          }
          case 'ion:remote-analyse-bench-verification': {
            const tabId = await store.openBenchVerificationAnalysis(repoPath, sourceBranch)
            send('analyse_verification', { ok: true, tabId })
            return
          }
          case 'ion:remote-discard-bench-member-recordings': {
            const branchNames = Array.isArray(arg.branchNames) && arg.branchNames.every((name) => typeof name === 'string')
              ? arg.branchNames as string[] : []
            const result = await store.benchDiscardMemberRecordings(repoPath, sourceBranch, branchNames)
            send('discard_recordings', { ok: result.ok, error: result.error })
            return
          }
          case 'ion:remote-discard-all-bench-recordings': {
            const workspace = (store.benchWorkspaces.get(repoPath) ?? []).find((item) => item.sourceBranch === sourceBranch)
            if (!workspace) throw new Error('No integration workspace for this source branch.')
            await store.benchRerereDiscardAll(workspace.benchPath)
            await store.refreshBench(repoPath)
            send('discard_recordings', { ok: true })
            return
          }
          case 'ion:remote-worktree-conflict-assist': {
            // The desktop ConflictsDialog's "AI Assisted" verb, wire-reachable:
            // one fresh auto-mode resolver conversation in the conflicted
            // worktree. openConflictAssist dedupes per directory, so a repeat
            // tap while a resolver runs focuses-by-result instead of stacking
            // a second agent — the same reactivation block the desktop slot
            // enforces visually.
            const tabId = await store.openConflictAssist(worktreePath)
            send('conflict_assist', { ok: true, tabId })
            return
          }
          case 'ion:remote-bench-conflict-assist': {
            // Chain: recreate the failed assembly merge in the bench (or
            // reassemble outright when recordings already cover it), then
            // launch the assisted resolver on the bench directory. Mirrors
            // BenchConflictDialog's "Resolve once" followed by the
            // ConflictsDialog's "AI Assisted".
            const benchPath = await store.benchResolveConflict(repoPath, sourceBranch)
            if (!benchPath) {
              // Recordings covered every conflict; the store reassembled.
              send('conflict_assist', { ok: true })
              return
            }
            const tabId = await store.openConflictAssist(benchPath)
            send('conflict_assist', { ok: true, tabId })
            return
          }
        }
      }
      void run().catch((err) => {
        rError('remote', 'worktree action failed', { action, error: String(err) })
        // Both assist chains answer as `conflict_assist`; the remaining
        // channels map 1:1 by stripping the prefix.
        const operation = action.endsWith('-conflict-assist')
          ? 'conflict_assist'
          : action.replace('ion:remote-', '').replaceAll('-', '_')
        send(operation, { ok: false, error: String(err) })
      })
    })
  }, [])

  // A shell in the bench, rather than a conversation about it. The store action
  // owns the one-terminal-per-bench decision, so the phone and the git panel
  // land on the same tab.
  useEffect(() => {
    return window.ion.onRemoteOpenBenchTerminal(({ repoPath, sourceBranch }) => {
      void useSessionStore.getState().openBenchTerminal(repoPath, sourceBranch)
        .then((tabId) => sendOpenResult(tabId, 'Could not open bench terminal.'))
        .catch((err) => {
          rError('remote', 'open bench terminal failed', { error: String(err) })
          window.ion.sendRemote({
            type: 'desktop_worktree_op_result',
            operation: 'open',
            ok: false,
            error: String(err),
          })
        })
    })
  }, [])

  // iOS drives the sync pipeline. Start acknowledges with a pipeline_start op
  // result (started or refused-because-running); every phase change reaches
  // iOS through the state subscription below.
  useEffect(() => {
    return window.ion.onRemoteWorktreePipeline(({ verb, repoPath, sourceBranch }) => {
      const store = useSessionStore.getState()
      switch (verb) {
        case 'start': {
          const existing = store.worktreePipeline
          if (existing && existing.phase !== 'done' && existing.phase !== 'failed') {
            window.ion.sendRemote({
              type: 'desktop_worktree_op_result',
              operation: 'pipeline_start',
              ok: false,
              error: 'A sync pipeline is already running.',
            })
            return
          }
          window.ion.sendRemote({ type: 'desktop_worktree_op_result', operation: 'pipeline_start', ok: true })
          void store.startWorktreePipeline(repoPath, sourceBranch ?? null)
            .catch((err) => rError('remote', 'pipeline start failed', { repo_path: repoPath, error: String(err) }))
          return
        }
        case 'confirm-ai':
          void store.confirmWorktreePipelineAi()
            .catch((err) => rError('remote', 'pipeline AI confirm failed', { repo_path: repoPath, error: String(err) }))
          return
        case 'cancel':
          store.cancelWorktreePipeline()
          return
        case 'dismiss':
          store.dismissWorktreePipeline()
          return
      }
    })
  }, [])

  // Mirror every pipeline phase/progress change onto the wire so iOS renders
  // the same banner (and the AI-confirm gate) the desktop panel shows. The
  // last repoPath is retained so the dismissal event (pipeline → null) still
  // names which repo's banner to clear.
  useEffect(() => {
    let lastRepoPath = ''
    return useSessionStore.subscribe((state, prev) => {
      if (state.worktreePipeline === prev.worktreePipeline) return
      if (state.worktreePipeline) lastRepoPath = state.worktreePipeline.repoPath
      window.ion.sendRemote(projectPipelineToWire(state.worktreePipeline, lastRepoPath))
    })
  }, [])
}
