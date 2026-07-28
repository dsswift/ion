/**
 * Session working-directory reconciliation — the guard that makes a prompt's
 * project path authoritative over the directory its session happened to start
 * in.
 *
 * ── The defect this exists to prevent ───────────────────────────────────────
 * The engine pins a session's working directory at `start_session`
 * (`engine/internal/session/prompt_options.go` reads `s.config.WorkingDirectory`
 * into `RunOptions.ProjectPath`), and no `ClientCommand` on the wire changes it
 * afterward. Restart-in-place is the only mechanism, which is what
 * `relocateTabSession` does.
 *
 * `submitPrompt` computes the correct directory into `config.workingDirectory`
 * on EVERY prompt, but its start site is guarded by
 * `if (!tab.engineSessionStarted)`. Once a session is live that branch never
 * runs, so a prompt whose directory differs from the started one had its
 * directory SILENTLY DISCARDED — the prompt ran in the old cwd with nothing in
 * the logs to say so.
 *
 * That is how five worktree conversations came to run in one shared checkout:
 * the tab's session was pre-started in the repo before its worktree existed,
 * the renderer later patched `tab.workingDirectory` to the worktree, and every
 * subsequent prompt carried the right path only to have it dropped here.
 *
 * ── Why reconcile rather than fix only the creation order ───────────────────
 * The creation-order fix (resolving the worktree before the session starts) is
 * necessary but not sufficient: it repairs ONE path into this state. Any future
 * caller that changes a tab's directory without relocating re-creates the bug,
 * and the failure is invisible. This reconciler makes the divergence
 * structurally impossible to ignore — the session always converges on the
 * directory the prompt asked for, and a divergence that had to be corrected
 * logs at WARN so it is visible in ~/.ion/desktop.jsonl the first time it
 * recurs rather than after five conversations have interleaved.
 *
 * ── Where the "started" directory comes from ────────────────────────────────
 * `bridge.getSessionConfig(key)` — the bridge retains the last `EngineConfig`
 * used to start each session key. This is the same source the divergence-resume
 * path in `engine-control-plane-events.ts` already trusts to carry a tab's real
 * `workingDirectory` across a restart, so there is one authoritative answer to
 * "what directory is this session actually running in", not two.
 */
import { log as _log, debug as _debug, warn as _warn } from './logger'
import type { TabEntry } from './engine-control-plane-events'

const TAG = 'SessionPlane'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function debug(msg: string, fields?: Record<string, unknown>): void { _debug(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Dependencies the reconciler needs from the control plane. Passed in rather
 * than imported so this module is testable without an EngineBridge or a live
 * EngineControlPlane.
 */
export interface ReconcileDeps {
  /**
   * The directory the session for this key was actually STARTED with, or
   * undefined when the key was never started. Backed by
   * `EngineBridge.getSessionConfig`.
   */
  startedWorkingDirectory: (tabId: string) => string | undefined
  /**
   * Non-destructive session restart. Clears `engineSessionStarted` while
   * PRESERVING `conversationId`, so the conversation survives the move.
   * Backed by `EngineControlPlane.restartTabSession`.
   */
  restartSession: (tabId: string) => void
  /** Idempotent start with a caller-supplied working directory. */
  ensureSession: (
    tabId: string,
    opts: { workingDirectory: string; conversationId?: string | null; permissionMode?: 'auto' | 'plan' },
  ) => Promise<{ ok: boolean; error?: string }>
}

export interface ReconcileResult {
  /** True when a relocation was performed (the session was moved). */
  relocated: boolean
  /** Set when the relocation was attempted and failed. */
  error?: string
}

/**
 * Ensure `tabId`'s live engine session is running in `promptDir`, relocating it
 * when it is not.
 *
 * Returns `{ relocated: false }` for every no-op case — session not started
 * yet (the caller's own start site handles it), no prompt directory supplied,
 * no recorded started directory, or the two already agree.
 *
 * Every branch logs. The no-op cases log at debug because they are the common
 * path on every prompt; the divergence logs at warn because it means something
 * upstream changed a tab's directory without relocating, which is a defect
 * worth seeing even though this function corrects it.
 */
export async function reconcileSessionWorkingDirectory(
  deps: ReconcileDeps,
  tabId: string,
  tab: TabEntry,
  promptDir: string,
): Promise<ReconcileResult> {
  // Not started yet: submitPrompt's own `if (!tab.engineSessionStarted)` start
  // site is about to start it with this very directory. Reconciling here would
  // be a redundant restart of a session that does not exist.
  if (!tab.engineSessionStarted) {
    debug('reconcile_cwd: session not started, nothing to reconcile', {
      tab_id: tabId,
      conversation_id: tab.conversationId ?? '',
      prompt_dir: promptDir,
    })
    return { relocated: false }
  }

  // A prompt that carries no project path asserts nothing about where the
  // conversation lives, so the started directory stands. Treating empty as
  // "relocate to nowhere" would tear down a working session on a partial run
  // options payload.
  if (!promptDir) {
    debug('reconcile_cwd: prompt carries no project path, keeping started directory', {
      tab_id: tabId,
      conversation_id: tab.conversationId ?? '',
    })
    return { relocated: false }
  }

  const startedDir = deps.startedWorkingDirectory(tabId)

  // No recorded config for a session the tab believes is started. Fail OPEN:
  // relocating on an unknown baseline would restart the session on every
  // prompt, which is strictly worse than leaving a session the bridge cannot
  // describe. Logged at warn because the flag and the bridge disagree, which is
  // itself worth seeing.
  if (startedDir === undefined) {
    warn('reconcile_cwd: session marked started but bridge has no config; leaving it alone', {
      tab_id: tabId,
      conversation_id: tab.conversationId ?? '',
      prompt_dir: promptDir,
    })
    return { relocated: false }
  }

  if (startedDir === promptDir) {
    debug('reconcile_cwd: session directory matches the prompt', {
      tab_id: tabId,
      conversation_id: tab.conversationId ?? '',
      working_dir: startedDir,
    })
    return { relocated: false }
  }

  // Divergence. The prompt's directory wins: it is derived from the tab's
  // current `workingDirectory`, which is what the operator and the UI believe
  // the conversation is working in.
  warn('reconcile_cwd: prompt directory diverges from the started session; relocating', {
    tab_id: tabId,
    conversation_id: tab.conversationId ?? '',
    from: startedDir,
    to: promptDir,
  })

  // Recycle the transport, preserving conversationId, then start again in the
  // prompt's directory resuming the same conversation. This is the same
  // two-step composition `relocateTabSession` performs; it is inlined against
  // the injected deps so the reconciler does not need a second path through the
  // control plane's public relocate method (which would re-read the tab map).
  deps.restartSession(tabId)

  const result = await deps.ensureSession(tabId, {
    workingDirectory: promptDir,
    conversationId: tab.conversationId,
    permissionMode: tab.permissionMode,
  })

  if (!result.ok) {
    warn('reconcile_cwd: relocation failed', {
      tab_id: tabId,
      conversation_id: tab.conversationId ?? '',
      to: promptDir,
      error: result.error ?? 'unknown',
    })
    return { relocated: false, error: result.error }
  }

  log('reconcile_cwd: relocated', {
    tab_id: tabId,
    conversation_id: tab.conversationId ?? '',
    from: startedDir,
    to: promptDir,
  })
  return { relocated: true }
}
