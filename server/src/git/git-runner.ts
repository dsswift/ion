import { existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { dataDir } from '../paths'
import { log as _log, warn as _warn } from '../logger'
import { gitExec, withGitSlot, withCliPath } from './git-exec'
import { currentPrincipal } from '../identity/request-principal'
import { hostForGitInvocation } from './identity/remote-host'
import { resolveGitCredential } from './identity/resolver'
import { materializeGitCredential } from './identity/materialize'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

// Re-exported for existing `from '../git/git-runner'` callers
// (worktree/safety.ts, worktree/patch-identity.ts, git-api-ops.ts,
// worktree/sync.ts) -- the primitives themselves moved to `git-exec.ts` to
// break an import cycle with `identity/remote-host.ts` (see that file's
// module doc).
export { gitExec, withGitSlot }

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

/** Git subcommands that talk to a remote -- the only ones FR-04's credential resolution (SSH key / HTTPS token) is relevant to. Author env applies regardless of subcommand (see `principalGitEnv`). */
const NETWORK_GIT_SUBCOMMANDS = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote'])

/** `{GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL}` for the ambient principal, or undefined when it lacks a usable name+email. Mirrors the engine's own `session.gitIdentityEnv` (FR-04 engine half) for the SERVER's own git operations (worktree land/sync, squash/align) rather than an agent's tool calls. */
function principalAuthorEnv(): Record<string, string> | undefined {
  const principal = currentPrincipal()
  if (!principal?.email) return undefined
  const name = principal.displayName || principal.username
  if (!name) return undefined
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: principal.email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: principal.email,
  }
}

/**
 * FR-04: the additive env `runGit` merges in when a caller omits its own
 * `env` -- the ambient principal's author identity always, plus a resolved
 * credential (SSH key / HTTPS token, see `identity/resolver.ts` and
 * `identity/materialize.ts`) for network subcommands whose remote host can
 * be determined (`identity/remote-host.ts`). Returns undefined when there is
 * no ambient principal at all (the historical single-owner-desktop path,
 * unchanged) so `runGit`'s no-merge fast path stays untouched.
 */
async function principalGitEnv(directory: string, args: string[]): Promise<Record<string, string> | undefined> {
  const principal = currentPrincipal()
  if (!principal) return undefined
  const authorEnv = principalAuthorEnv()

  const subcommand = args.find((a) => !a.startsWith('-'))
  if (!subcommand || !NETWORK_GIT_SUBCOMMANDS.has(subcommand)) return authorEnv

  try {
    const host = await hostForGitInvocation(directory, args)
    if (!host) return authorEnv
    const cred = await resolveGitCredential(principal.subject, host)
    if (!cred) return authorEnv
    const credEnv = await materializeGitCredential(principal.subject, cred)
    return { ...authorEnv, ...credEnv }
  } catch (err) {
    warn('git_runner: principal credential resolution failed; falling back to no credential env', { subject: principal.subject, error: String(err) })
    return authorEnv
  }
}

/**
 * The environment a caller that spawns git ITSELF (a streaming `clone
 * --progress`, which `runGit`'s buffered exec cannot report on) should pass
 * to its child: the parent environment with the operator's PATH (see
 * `gitExec`), plus the ambient principal's author identity and materialised
 * credential for `args`' remote host, exactly as `runGit` would merge in. Without an ambient principal only PATH differs
 * from the parent environment.
 */
export async function resolveGitEnvFor(directory: string, args: string[]): Promise<NodeJS.ProcessEnv> {
  const extra = await principalGitEnv(directory, args)
  return withCliPath(extra ? { ...process.env, ...extra } : process.env)
}

/**
 * Run a git command in `directory` and return its stdout.
 *
 * `env` is optional and ADDITIVE: when omitted, FR-04's `principalGitEnv`
 * resolves the ambient principal's author identity and (for a network
 * subcommand) credential, merged over the inherited parent environment; when
 * there is no ambient principal at all, the child inherits the parent
 * environment. An explicit `env` argument bypasses `principalGitEnv`
 * entirely and is used as-is -- existing plumbing that must
 * run against a scratch index via `GIT_INDEX_FILE` (see worktree/recovery.ts)
 * already builds its own full env and must not have FR-04 layered on top of
 * a snapshot commit that intentionally runs outside the operator's real
 * index. Either way `gitExec` swaps in the operator's PATH.
 */
export async function runGit(
  directory: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const resolvedEnv = env ?? (await principalGitEnv(directory, args).then((extra) => (extra ? { ...process.env, ...extra } : undefined)))
  try {
    const { stdout } = await withGitSlot(() => gitExec('git', withNoOptionalLocks(args), {
      cwd: directory,
      maxBuffer: 10 * 1024 * 1024,
      ...(resolvedEnv ? { env: resolvedEnv } : {}),
    }))
    return stdout
  } catch (err: any) {
    throw new Error(err.stderr?.trim() || err.message)
  }
}

/**
 * Run a read-only Git command that may signal a meaningful result with exit
 * code 1. `git diff --no-index` does this whenever files differ, despite
 * producing a valid patch on stdout.
 */
export async function runGitAllowingDiffExit(
  directory: string,
  args: string[],
): Promise<string> {
  try {
    const { stdout } = await withGitSlot(() => gitExec('git', withNoOptionalLocks(args), {
      cwd: directory,
      maxBuffer: 10 * 1024 * 1024,
    }))
    return stdout
  } catch (err: unknown) {
    const failure = err as { code?: number; stdout?: unknown; stderr?: unknown; message?: unknown }
    if (failure.code === 1 && typeof failure.stdout === 'string') return failure.stdout
    throw new Error(typeof failure.stderr === 'string' ? failure.stderr.trim() : String(failure.message ?? err))
  }
}

export async function cleanOrphanedWorktrees(): Promise<void> {
  const worktreeDir = join(dataDir(), 'worktrees')
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
