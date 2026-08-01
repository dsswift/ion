/**
 * Interactive-rebase git IPC handlers, split out from ipc/git.ts to stay under
 * the file-size cap.
 *
 * Owns the four channels behind the rebase UI: reading the todo list, executing
 * a rebase with a pre-built todo, and the abort/continue pair that drives an
 * operation already in progress.
 *
 * ── Abort/continue are OPERATION-AWARE ──────────────────────────────────────
 * The channel names say "rebase" (their original scope), but the ConflictsDialog
 * drives them for whatever operation is actually in progress — a conflicted
 * sync (rebase), a conflicted merge (the bench resolve-once flow), or a
 * cherry-pick. The handlers probe the real state and run the matching git
 * verb: `git rebase --continue` against a merge fails with "no rebase in
 * progress", which read as a dead button.
 *
 * All three mutating channels are bench-guarded. A rebase inside an integration
 * bench rewrites a branch the next assembly recreates from scratch, so the work
 * is destroyed; see integration/bench-guard.ts and
 * docs/architecture/adr/024-integration-workspace.md. The guard itself carves
 * out merge continue/abort while a machinery-prepared merge is in progress —
 * that is the bench conflict resolve-once flow. GIT_REBASE_TODO is a read
 * (`git log`) and is deliberately not guarded.
 */

import { ipcMain } from 'electron'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { IPC } from '../../shared/types'
import { runGit, gitExec } from '../git-runner'
import { benchGuard } from '../integration/bench-guard'
import { probeOperationState } from '../git/operation-state'

/**
 * Resolve the in-progress operation to the git verb and the guard label for
 * an abort/continue request. Defaults to `rebase` when no operation is
 * detected: the error message from git ("no rebase in progress") is then the
 * honest answer to a stale button.
 */
async function operationVerb(directory: string): Promise<{ verb: 'rebase' | 'merge' | 'cherry-pick'; label: string }> {
  const probe = await probeOperationState(directory)
  if (probe.state === 'merging') return { verb: 'merge', label: 'merge' }
  if (probe.state === 'cherry-picking') return { verb: 'cherry-pick', label: 'cherry-pick' }
  return { verb: 'rebase', label: 'rebase' }
}

export function registerGitRebaseIpc(): void {
  ipcMain.handle(IPC.GIT_REBASE_TODO, async (_event, { directory, onto }: { directory: string; onto: string }) => {
    try {
      const output = await runGit(directory, ['log', '--reverse', '--format=%H%x00%s', `${onto}..HEAD`])
      const commits = output.trim().split('\n').filter(Boolean).map(line => {
        const [hash, subject] = line.split('\x00')
        return { hash, subject, action: 'pick' as const }
      })
      return { commits, ok: true }
    } catch (err: any) {
      return { commits: [], ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GIT_REBASE_EXEC, async (_event, { directory, onto, commits }: { directory: string; onto: string; commits: Array<{ hash: string; action: string }> }) => {
    const refusal = benchGuard(directory, 'rebase')
    if (refusal) return refusal
    try {
      const todoContent = commits
        .filter(c => c.action !== 'drop')
        .map(c => `${c.action} ${c.hash}`)
        .join('\n') + '\n'

      const todoFile = join(tmpdir(), `ion-rebase-todo-${Date.now()}`)
      writeFileSync(todoFile, todoContent)

      // Use GIT_SEQUENCE_EDITOR to supply our pre-built todo list
      const env = { ...process.env, GIT_SEQUENCE_EDITOR: `cat "${todoFile}" >` }
      await gitExec('git', ['rebase', '-i', onto], { cwd: directory, maxBuffer: 10 * 1024 * 1024, env })

      try { unlinkSync(todoFile) } catch { /* silent-ok: best-effort rebase-todo temp-file cleanup */ }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.stderr?.trim() || err.message }
    }
  })

  ipcMain.handle(IPC.GIT_REBASE_ABORT, async (_event, { directory }: { directory: string }) => {
    const op = await operationVerb(directory)
    const refusal = benchGuard(directory, `abort a ${op.label}`)
    if (refusal) return refusal
    try {
      await runGit(directory, [op.verb, '--abort'])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GIT_REBASE_CONTINUE, async (_event, { directory }: { directory: string }) => {
    const op = await operationVerb(directory)
    const refusal = benchGuard(directory, `continue a ${op.label}`)
    if (refusal) return refusal
    try {
      // `--no-edit` for merge/cherry-pick: continuing must not park the main
      // process on an editor that can never appear. Rebase keeps its own
      // continue semantics (it opens no editor for a plain continue).
      if (op.verb === 'merge') {
        await runGit(directory, ['-c', 'core.editor=true', 'merge', '--continue'])
      } else {
        await runGit(directory, ['-c', 'core.editor=true', op.verb, '--continue'])
      }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
}
