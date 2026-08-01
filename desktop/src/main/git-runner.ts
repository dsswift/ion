import { execFile as execFileCb } from 'child_process'
import { existsSync, readdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { log as _log, warn as _warn } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

export const gitExec = promisify(execFileCb)

/**
 * Global cap on concurrent git subprocesses spawned through `runGit`.
 *
 * ── Why a semaphore exists here ─────────────────────────────────────────────
 * `posix_spawn` runs on the Electron main thread's event loop (libuv), so an
 * unbounded caller — a poller storm, an inventory crawl over dozens of
 * worktrees, several windows refreshing at once — saturates the loop with
 * spawn syscalls and starves IPC and window commands. That is exactly what
 * froze the overlay: overlapping worktree-inventory crawls piled up until the
 * main process spent 73% CPU inside uv_spawn and hide/show took minutes.
 *
 * The cap turns any future caller storm into an ordered queue that the event
 * loop drains at a sustainable rate. It is a BACKSTOP: callers are still
 * expected to coalesce their own work (see worktree/inventory-service.ts); the
 * semaphore is what keeps the UI alive when one of them fails to.
 *
 * Deliberately NOT applied to `gitExec` direct users: those are one-off or
 * potentially long-running commands (interactive rebase, merge-tree dry runs,
 * startup cleanup) where holding a shared slot for the duration would starve
 * the short read probes this queue exists to protect.
 */
const MAX_CONCURRENT_GIT = 6
/** Queue depth at which the backstop starts announcing itself. */
const QUEUE_WARN_DEPTH = 16
/** Minimum interval between queue-depth warnings, so a storm logs a heartbeat rather than a flood. */
const QUEUE_WARN_INTERVAL_MS = 5000

let activeGitSlots = 0
const gitSlotWaiters: Array<() => void> = []
let lastQueueWarnAt = 0

async function acquireGitSlot(): Promise<void> {
  if (activeGitSlots < MAX_CONCURRENT_GIT) {
    activeGitSlots++
    return
  }
  const depth = gitSlotWaiters.length + 1
  const now = Date.now()
  if (depth >= QUEUE_WARN_DEPTH && now - lastQueueWarnAt >= QUEUE_WARN_INTERVAL_MS) {
    lastQueueWarnAt = now
    warn('git_runner: spawn queue backed up — a caller is issuing more git than the cap drains', {
      queued: depth,
      max_concurrent: MAX_CONCURRENT_GIT,
    })
  }
  await new Promise<void>((resolve) => gitSlotWaiters.push(resolve))
}

function releaseGitSlot(): void {
  const next = gitSlotWaiters.shift()
  // Hand the slot to the next waiter directly rather than decrementing and
  // re-incrementing, so the count can never transiently over-admit.
  if (next) next()
  else activeGitSlots--
}

/**
 * Run `fn` while holding one of the shared git-subprocess slots.
 *
 * Exported so callers that must spawn git outside `runGit` (a scratch-index
 * invocation with GIT_INDEX_FILE, see worktree/safety.ts) count against the
 * same global cap instead of bypassing it.
 *
 * `fn` must not itself call `runGit`/`withGitSlot` — a holder awaiting a
 * second slot while every slot waits on holders is the textbook deadlock.
 */
export async function withGitSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireGitSlot()
  try {
    return await fn()
  } finally {
    releaseGitSlot()
  }
}

/**
 * Git subcommands that only read repository state.
 *
 * These are the calls that get `--no-optional-locks` (see withNoOptionalLocks).
 * Anything absent from this set — commit, add, rebase, checkout, stash, push —
 * is a mutating command that must keep its normal locking behavior, so the
 * allowlist is deliberately explicit rather than a deny-list.
 */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'blame',
  'branch',
  'cat-file',
  'diff',
  'diff-tree',
  'for-each-ref',
  'log',
  'ls-files',
  'ls-remote',
  'merge-base',
  'name-rev',
  'remote',
  'rev-list',
  'rev-parse',
  'show',
  'show-ref',
  'status',
  'symbolic-ref',
  'worktree',
])

/**
 * Prefix read-only git invocations with --no-optional-locks.
 *
 * `git status` (and other readers) opportunistically refresh the on-disk index,
 * and that refresh takes .git/index.lock. The desktop polls git state
 * frequently — status broadcasts, the git panel, worktree listings — so those
 * reads collide with whatever the operator is running in the same repo: an
 * interactive rebase, an amend, or a squash dies with
 * "Unable to create '.git/index.lock': File exists".
 *
 * The flag suppresses only *optional* locks, so output is unchanged and
 * mutating commands are left alone. Subcommand detection skips leading
 * `-c key=value` pairs, which callers use to pass per-invocation config.
 */
function withNoOptionalLocks(args: string[]): string[] {
  let i = 0
  while (i < args.length) {
    if (args[i] === '-c' || args[i] === '--config-env') {
      i += 2
      continue
    }
    if (args[i].startsWith('-')) {
      i += 1
      continue
    }
    break
  }
  if (i >= args.length || !READ_ONLY_GIT_SUBCOMMANDS.has(args[i])) return args
  return ['--no-optional-locks', ...args]
}

/**
 * Run a git command in `directory` and return its stdout.
 *
 * `env` is optional and ADDITIVE: when omitted the child inherits the parent
 * environment exactly as before. It exists for plumbing that must run against a
 * scratch index via `GIT_INDEX_FILE` (see worktree/recovery.ts) — writing a
 * snapshot commit must never disturb the operator's real index, and the env var
 * is git's only mechanism for that.
 */
export async function runGit(
  directory: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await withGitSlot(() => gitExec('git', withNoOptionalLocks(args), {
      cwd: directory,
      maxBuffer: 10 * 1024 * 1024,
      ...(env ? { env } : {}),
    }))
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
