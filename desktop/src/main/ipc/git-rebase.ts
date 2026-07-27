/**
 * Interactive-rebase git IPC handlers, split out from ipc/git.ts to stay under
 * the file-size cap.
 *
 * Owns the four channels behind the rebase UI: reading the todo list, executing
 * a rebase with a pre-built todo, and the abort/continue pair that drives a
 * rebase already in progress.
 *
 * All three mutating channels are bench-guarded. A rebase inside an integration
 * bench rewrites a branch the next rebuild recreates from scratch, so the work
 * is destroyed; see integration/bench-guard.ts and
 * docs/architecture/adr/024-integration-workspace.md. GIT_REBASE_TODO is a read
 * (`git log`) and is deliberately not guarded.
 */

import { ipcMain } from 'electron'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { IPC } from '../../shared/types'
import { runGit, gitExec } from '../git-runner'
import { benchGuard } from '../integration/bench-guard'

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
    const refusal = benchGuard(directory, 'abort a rebase')
    if (refusal) return refusal
    try {
      await runGit(directory, ['rebase', '--abort'])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GIT_REBASE_CONTINUE, async (_event, { directory }: { directory: string }) => {
    const refusal = benchGuard(directory, 'continue a rebase')
    if (refusal) return refusal
    try {
      await runGit(directory, ['rebase', '--continue'])
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })
}
