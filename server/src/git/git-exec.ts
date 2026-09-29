/**
 * The shared git-subprocess primitive: `gitExec` (a promisified `execFile`)
 * plus the global concurrency semaphore (`withGitSlot`). Split out of
 * `git-runner.ts` so `git/identity/remote-host.ts` can spawn `git remote
 * get-url` through the same cap without an import cycle (`git-runner.ts`
 * itself needs to reach into `git/identity/` to resolve a principal's
 * credential env, and `remote-host.ts` needs to spawn a subprocess -- both
 * cannot import `git-runner.ts` at once). `git-runner.ts` re-exports both
 * names, so every existing `from '../git/git-runner'` import is unaffected.
 */
import { execFile as execFileCb } from 'child_process'
import type { ExecFileOptions } from 'child_process'
import { promisify } from 'util'
import { warn as _warn } from '../logger'
import { getCliPath } from '../cli-env'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

/**
 * Promisified `execFile`, resolved lazily on first call rather than at
 * module load. A handful of desktop test files mock the `child_process`
 * module wholesale with only `spawn`/`execSync` (they predate this module
 * and have no reason to know about it) -- `promisify(execFileCb)` at the top
 * level would evaluate `execFileCb` (undefined under that mock) the moment
 * ANYTHING transitively imports this file, crashing tests that never
 * intended to exercise git at all. Lazy resolution defers that read to the
 * first real call, by which point either the real `child_process.execFile`
 * exists or the test is exercising this path deliberately (and provides it).
 */
type PromisifiedExecFile = (file: string, args?: readonly string[], options?: ExecFileOptions) => Promise<{ stdout: string; stderr: string }>

let promisified: PromisifiedExecFile | null = null

/**
 * Run git with the operator's login-shell PATH.
 *
 * git runs repository hooks (commit-msg, pre-commit, post-merge,
 * post-checkout), filters such as git-lfs, and credential helpers as child
 * processes, and those find their tools through PATH. A desktop launched from
 * Finder inherits launchd's bare `/usr/bin:/bin:/usr/sbin:/sbin`, so a hook
 * like husky's `npx --no -- commitlint` fails with "command not found" and
 * takes the merge or commit down with it. `getCliPath()` is the same PATH the
 * terminals get. It replaces only PATH; every other variable in the caller's
 * `env` (or the inherited environment) passes through untouched.
 */
export function gitExec(file: string, args?: readonly string[], options?: ExecFileOptions): Promise<{ stdout: string; stderr: string }> {
  promisified ??= promisify(execFileCb) as unknown as PromisifiedExecFile
  return promisified(file, args, { ...options, env: withCliPath(options?.env) })
}

/** `env` (or the inherited environment) with PATH replaced by the operator's login-shell PATH. */
export function withCliPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PATH: getCliPath() }
}

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
