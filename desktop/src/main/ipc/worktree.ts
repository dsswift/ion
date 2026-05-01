import { ipcMain } from 'electron'
import { mkdirSync, readdirSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { basename, join } from 'path'
import { IPC } from '../../shared/types'
import type { WorktreeInfo, WorktreeStatus } from '../../shared/types'
import { runGit } from '../git-runner'

export function registerWorktreeIpc(): void {
  ipcMain.handle(IPC.GIT_WORKTREE_ADD, async (_event, { repoPath, sourceBranch }: { repoPath: string; sourceBranch: string }) => {
    try {
      const id = randomBytes(4).toString('hex')
      const branchName = `wt/${randomBytes(4).toString('hex')}`
      const worktreeDir = join(homedir(), '.ion', 'worktrees')
      const worktreePath = join(worktreeDir, `${basename(repoPath)}-${id}`)
      mkdirSync(worktreeDir, { recursive: true })
      await runGit(repoPath, ['worktree', 'add', '-b', branchName, worktreePath, sourceBranch])
      const worktree: WorktreeInfo = { worktreePath, branchName, sourceBranch, repoPath }
      return { ok: true, worktree }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GIT_WORKTREE_REMOVE, async (_event, { repoPath, worktreePath, branchName, force }: { repoPath: string; worktreePath: string; branchName: string; force?: boolean }) => {
    try {
      const removeArgs = ['worktree', 'remove', worktreePath]
      if (force) removeArgs.push('--force')
      await runGit(repoPath, removeArgs)
      try { await runGit(repoPath, ['branch', '-D', branchName]) } catch {}
      try {
        const parent = join(worktreePath, '..')
        const entries = readdirSync(parent)
        if (entries.length === 0) rmSync(parent, { recursive: true })
      } catch {}
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GIT_WORKTREE_LIST, async (_event, { repoPath }: { repoPath: string }) => {
    try {
      const raw = await runGit(repoPath, ['worktree', 'list', '--porcelain'])
      const worktrees: Array<{ path: string; branch: string; head: string }> = []
      const blocks = raw.trim().split('\n\n')
      for (const block of blocks) {
        if (!block.trim()) continue
        const lines = block.trim().split('\n')
        let wtPath = ''
        let head = ''
        let branch = ''
        for (const line of lines) {
          if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length)
          else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
          else if (line.startsWith('branch ')) branch = line.slice('branch refs/heads/'.length)
        }
        if (wtPath) worktrees.push({ path: wtPath, branch, head })
      }
      return { worktrees }
    } catch {
      return { worktrees: [] }
    }
  })

  ipcMain.handle(IPC.GIT_WORKTREE_STATUS, async (_event, { worktreePath, sourceBranch }: { worktreePath: string; sourceBranch: string }) => {
    try {
      const statusOutput = await runGit(worktreePath, ['status', '--porcelain'])
      const hasUncommittedChanges = statusOutput.trim().length > 0

      let aheadCount = 0
      let behindCount = 0
      try {
        const ahead = await runGit(worktreePath, ['rev-list', '--count', `${sourceBranch}..HEAD`])
        aheadCount = parseInt(ahead.trim(), 10) || 0
      } catch {}
      try {
        const behind = await runGit(worktreePath, ['rev-list', '--count', `HEAD..${sourceBranch}`])
        behindCount = parseInt(behind.trim(), 10) || 0
      } catch {}

      let isMerged = false
      try {
        await runGit(worktreePath, ['merge-base', '--is-ancestor', 'HEAD', sourceBranch])
        isMerged = true
      } catch {}

      const status: WorktreeStatus = {
        hasUncommittedChanges,
        hasUnpushedCommits: aheadCount > 0,
        isMerged,
        aheadCount,
        behindCount,
      }
      return status
    } catch {
      return { hasUncommittedChanges: false, hasUnpushedCommits: false, isMerged: false, aheadCount: 0, behindCount: 0 }
    }
  })

  ipcMain.handle(IPC.GIT_WORKTREE_MERGE, async (_event, { repoPath, worktreeBranch, sourceBranch }: { repoPath: string; worktreeBranch: string; sourceBranch: string }) => {
    try {
      await runGit(repoPath, ['checkout', sourceBranch])
      await runGit(repoPath, ['merge', '--no-ff', worktreeBranch])
      return { ok: true }
    } catch (err: any) {
      const msg = err.message || ''
      if (msg.includes('CONFLICT') || msg.includes('Merge conflict')) {
        return { ok: false, hasConflicts: true, error: msg }
      }
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle(IPC.GIT_WORKTREE_PUSH, async (_event, { worktreePath }: { worktreePath: string }) => {
    try {
      await runGit(worktreePath, ['push', '-u', 'origin', 'HEAD'])
      const remoteUrl = (await runGit(worktreePath, ['remote', 'get-url', 'origin'])).trim()
      const remoteBranch = (await runGit(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      return { ok: true, remoteBranch, remoteUrl }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle(IPC.GIT_WORKTREE_REBASE, async (_event, { worktreePath, sourceBranch }: { worktreePath: string; sourceBranch: string }) => {
    try {
      await runGit(worktreePath, ['fetch', 'origin'])
      await runGit(worktreePath, ['rebase', sourceBranch])
      return { ok: true }
    } catch (err: any) {
      const msg = err.message || ''
      const hasConflicts = msg.includes('CONFLICT') || msg.includes('could not apply')
      return { ok: false, error: msg, hasConflicts }
    }
  })
}
