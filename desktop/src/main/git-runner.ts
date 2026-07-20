import { execFile as execFileCb } from 'child_process'
import { existsSync, readdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { log as _log } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

export const gitExec = promisify(execFileCb)

export async function runGit(directory: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await gitExec('git', args, { cwd: directory, maxBuffer: 10 * 1024 * 1024 })
    return stdout
  } catch (err: any) {
    throw new Error(err.stderr?.trim() || err.message)
  }
}

export async function cleanOrphanedWorktrees(): Promise<void> {
  const worktreeDir = join(homedir(), '.ion', 'worktrees')
  if (!existsSync(worktreeDir)) return
  try {
    const entries = readdirSync(worktreeDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const wtPath = join(worktreeDir, entry.name)
      try {
        await gitExec('git', ['rev-parse', '--git-dir'], { cwd: wtPath })
      } catch {
        log('git_runner: cleaning orphaned worktree', { path: wtPath })
        try { rmSync(wtPath, { recursive: true, force: true }) } catch { /* silent-ok: best-effort orphaned-worktree removal */ }
      }
    }
  } catch (err: any) {
    log('git_runner: worktree cleanup error', { error: err.message })
  }
}
