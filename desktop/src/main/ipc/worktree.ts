import { ipcMain } from 'electron'
import { mkdirSync, readdirSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { basename, join } from 'path'
import { IPC } from '../../shared/types'
import type { WorktreeInfo, WorktreeStatus } from '../../shared/types'
import { runGit } from '../git-runner'
import { landWorktree } from '../worktree/integrate'
import {
  lookupWorktreeRegistration,
  registerWorktree,
  setWorktreeTitle,
  unregisterWorktree,
} from '../worktree/inventory'
import { provisionWorktree } from '../worktree/provision'
import { setProvisionState, clearProvisionState } from '../worktree/provision-state'
import { engineBridge } from '../state'
import { announceWorktreeTitle, MAX_TITLE_INPUT_CHARS } from '../worktree/title-announce'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'worktree.title'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export function registerWorktreeIpc(): void {
  ipcMain.handle(IPC.GIT_WORKTREE_ADD, async (_event, { repoPath, sourceBranch }: { repoPath: string; sourceBranch: string }) => {
    try {
      // ONE identity for the worktree, used for both the directory and the
      // branch. These used to be two independent randomBytes() calls, so a
      // worktree at `ion-452a6bd3` carried branch `wt/807940c2` — nothing
      // connected them, the row label showed the directory while every git
      // verb and every agent sentence used the branch, and the operator had to
      // consult the registry to map one to the other.
      //
      // Deriving both from one slug makes the mapping trivial in either
      // direction (`ion-a3372546` ⇄ `wt/ion-a3372546`), so a single label can
      // identify the worktree everywhere.
      const slug = `${basename(repoPath)}-${randomBytes(4).toString('hex')}`
      const branchName = `wt/${slug}`
      const worktreeDir = join(homedir(), '.ion', 'worktrees')
      const worktreePath = join(worktreeDir, slug)
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

  /**
   * Give a worktree a human title, generated from the first prompt sent inside
   * it. Called by the renderer on every send; the DECISION lives here.
   *
   * ── Why the main process decides ────────────────────────────────────────
   * "Is this directory a worktree, and has it been named yet?" is answered by
   * the registry, which is main-process state. A renderer-side check would read
   * the inventory snapshot it happens to hold — stale in the ATV mirror, absent
   * in a window that never opened the git panel — and would fire a duplicate
   * LLM call from each window on the same send. Deciding here means the answer
   * is read from the one authoritative record, and a worktree costs at most one
   * titling round-trip ever.
   *
   * Three no-op paths, each logged so the decision is reconstructable:
   *   - the directory is not a registered worktree (an ordinary project tab),
   *   - it already has a title (the common case after the first prompt),
   *   - the prompt carries no usable text.
   *
   * Failure is never fatal to the prompt that triggered it: the row keeps
   * showing its machine slug and the next prompt tries again.
   */
  ipcMain.handle(
    IPC.GIT_WORKTREE_AUTOTITLE,
    async (_event, { workingDirectory, text }: { workingDirectory: string; text: string }) => {
      if (!workingDirectory || !text.trim()) {
        log('autotitle skipped: nothing to work from', {
          worktree_path: workingDirectory, text_len: text?.length ?? 0,
        })
        return { ok: false, reason: 'empty-input' as const }
      }

      const registration = lookupWorktreeRegistration(workingDirectory)
      if (!registration) {
        log('autotitle skipped: not a registered worktree', { dir: workingDirectory })
        return { ok: false, reason: 'not-a-worktree' as const }
      }
      if (registration.title) {
        log('autotitle skipped: already titled', {
          worktree_path: workingDirectory, title: registration.title,
        })
        return { ok: false, reason: 'already-titled' as const, title: registration.title }
      }

      log('autotitle generating', {
        worktree_path: workingDirectory,
        repo_path: registration.repoPath,
        branch: registration.branchName,
        text_len: text.length,
      })
      let title = ''
      try {
        title = (await engineBridge.generateTitle(text.slice(0, MAX_TITLE_INPUT_CHARS))).trim()
      } catch (err) {
        warn('autotitle generation failed; the worktree keeps its slug', {
          worktree_path: workingDirectory, error: String(err),
        })
        return { ok: false, reason: 'generation-failed' as const }
      }
      if (!title) {
        // The engine returns "" when no titling model is configured. That is a
        // legitimate configuration, not an error — say so and move on.
        log('autotitle produced no title (no titling model configured?)', {
          worktree_path: workingDirectory,
        })
        return { ok: false, reason: 'empty-title' as const }
      }

      setWorktreeTitle(workingDirectory, title)
      log('autotitle applied', { worktree_path: workingDirectory, title })
      await announceWorktreeTitle(registration.repoPath, workingDirectory, title)
      return { ok: true, title }
    },
  )

  /**
   * Operator override for a worktree's title — the escape hatch when the
   * generated one is wrong. Upserts, so a hand-created worktree with no
   * registry entry can still be named (it is recorded with an unknown source
   * branch rather than a guessed one).
   */
  ipcMain.handle(
    IPC.GIT_WORKTREE_SET_TITLE,
    async (_event, { worktreePath, repoPath, title }: { worktreePath: string; repoPath?: string; title: string }) => {
      const trimmed = title.trim()
      const registration = lookupWorktreeRegistration(worktreePath)
      const resolvedRepo = repoPath || registration?.repoPath || ''
      if (!trimmed) {
        warn('rename refused: an empty title would leave the row unnamed', { worktree_path: worktreePath })
        return { ok: false, error: 'A title cannot be empty.' }
      }

      setWorktreeTitle(worktreePath, trimmed, { repoPath: resolvedRepo })
      log('worktree renamed by the operator', { worktree_path: worktreePath, title: trimmed })
      await announceWorktreeTitle(resolvedRepo, worktreePath, trimmed)
      return { ok: true, title: trimmed }
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
