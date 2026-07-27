import { ipcMain } from 'electron'
import { mkdirSync, readdirSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { basename, join } from 'path'
import { IPC } from '../../shared/types'
import type { WorktreeInfo, WorktreeStatus } from '../../shared/types'
import { runGit } from '../git-runner'
import { landWorktree } from '../worktree/integrate'
import { registerWorktree, unregisterWorktree } from '../worktree/inventory'
import { provisionWorktree } from '../worktree/provision'
import { setProvisionState, clearProvisionState } from '../worktree/provision-state'

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
      // Record the source branch: git does not store which branch a worktree
      // was cut from, and every lifecycle verb (land, sync, base staleness)
      // needs it. Without this the inventory has to guess, and a wrong guess
      // would land work into the wrong branch.
      registerWorktree({ worktreePath, repoPath, branchName, sourceBranch })

      // Provisioning runs BEHIND the worktree, not in front of it: the operator
      // gets a usable directory immediately and watches the dependency state
      // fill in. A cold `npm ci` would otherwise block worktree creation for
      // minutes. Fire-and-forget with `void` — every failure is captured into
      // provisionState rather than thrown, so there is nothing to await here.
      setProvisionState(worktreePath, 'seeding')
      void provisionWorktree(repoPath, worktreePath, (state, detail) => {
        setProvisionState(worktreePath, state, detail)
      }).catch((err) => {
        // Defensive: provisionWorktree is documented never to reject. If that
        // contract is ever broken the worktree must still end in a terminal
        // state rather than sitting in `seeding` forever.
        setProvisionState(worktreePath, 'failed', String(err))
      })

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
      try { await runGit(repoPath, ['branch', '-D', branchName]) } catch { /* silent-ok: best-effort branch delete; worktree already removed */ }
      unregisterWorktree(worktreePath)
      // Drop the provisioning record too: a future worktree reusing this path
      // must start with no state rather than inheriting a stale `failed`.
      clearProvisionState(worktreePath)
      try {
        const parent = join(worktreePath, '..')
        const entries = readdirSync(parent)
        if (entries.length === 0) rmSync(parent, { recursive: true })
      } catch { /* silent-ok: best-effort removal of the now-empty worktree parent dir */ }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  // Re-provision: re-run the ladder for a worktree whose dependency state the
  // operator believes is wrong. Deliberately the SAME path creation uses, so a
  // repair can never drift from a fresh provision.
  //
  // Awaited (unlike creation) because the caller asked for it explicitly and
  // wants to know the outcome.
  ipcMain.handle(
    IPC.GIT_WORKTREE_REPROVISION,
    async (_event, { repoPath, worktreePath }: { repoPath: string; worktreePath: string }) => {
      setProvisionState(worktreePath, 'seeding')
      const outcome = await provisionWorktree(repoPath, worktreePath, (state, detail) => {
        setProvisionState(worktreePath, state, detail)
      })
      return { ok: outcome.state === 'ready', state: outcome.state, error: outcome.error }
    },
  )

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
      } catch { /* silent-ok: no upstream/ref yet; ahead count stays 0 */ }
      try {
        const behind = await runGit(worktreePath, ['rev-list', '--count', `HEAD..${sourceBranch}`])
        behindCount = parseInt(behind.trim(), 10) || 0
      } catch { /* silent-ok: no upstream/ref yet; behind count stays 0 */ }

      let isMerged = false
      try {
        await runGit(worktreePath, ['merge-base', '--is-ancestor', 'HEAD', sourceBranch])
        isMerged = true
      } catch { /* silent-ok: non-zero exit means HEAD is not an ancestor; isMerged stays false */ }

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

  // GIT_WORKTREE_MERGE is retained as a channel (no wire removal) but its body
  // now DELEGATES to landWorktree. The original implementation ran a bare
  // `git checkout <sourceBranch>` in the main repo followed by `merge
  // --ff-only`, which clobbered the operator's checkout, could not be repeated
  // after another worktree landed, and raced other tabs. Routing through the
  // land path means no caller can bypass the dirty/branch preflight or the
  // per-repo serialization. See main/worktree/integrate.ts.
  ipcMain.handle(IPC.GIT_WORKTREE_MERGE, async (_event, { repoPath, worktreeBranch, sourceBranch, noFf, worktreePath }: { repoPath: string; worktreeBranch: string; sourceBranch: string; noFf?: boolean; worktreePath?: string }) => {
    return landWorktree({
      repoPath,
      // Older callers of this channel did not pass worktreePath. The land
      // preflight uses it only for the "is the worktree committed" gate;
      // falling back to repoPath keeps those callers working (the gate then
      // checks the repo, which is the conservative direction).
      worktreePath: worktreePath || repoPath,
      worktreeBranch,
      sourceBranch,
      noFf,
    })
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
