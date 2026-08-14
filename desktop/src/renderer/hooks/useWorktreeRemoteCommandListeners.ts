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
}
