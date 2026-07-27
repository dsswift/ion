// ion-meta deterministic bench-gate.
//
// Pure-function helper that decides whether a Bash command would write git
// HISTORY inside an integration bench. Used by the `tool_call` hook wired in
// index.ts to refuse history-writing git commands there.
//
// Why a bench must refuse history writes
// --------------------------------------
// A bench (an "integration workspace") is a REBUILDABLE worktree. Its branch is
// recreated from scratch on every rebuild:
//
//     git switch -C ion/bench/<slug> <sourceBranch> --discard-changes
//     git merge --no-ff <pinnedSha>   # per member, in order
//
// So a commit made in a bench is destroyed by the next rebuild, and a push
// would publish a synthetic merge of other people's in-flight work. Neither is
// recoverable and neither is what the operator meant. The bench exists to BUILD
// and TEST a combination, which is why reading, building, and testing stay
// completely unblocked — over-blocking would defeat its only purpose.
//
// Why this is a hook and not a persona rule
// -----------------------------------------
// Same reasoning as git-gate.ts: a persona-level "don't commit in the bench"
// instruction is LLM compliance, and a model swap, prompt rephrase, or context
// compression can erode it. The engine-level `tool_call` hook returning
// `{ block: true, reason }` is a deterministic refusal the LLM cannot bypass.
//
// Why this duplicates the desktop's containment rule
// --------------------------------------------------
// ion-meta ships as a standalone extension bundle and must not import from the
// desktop or the engine (see git-gate.ts — pure `node:` imports only). The
// desktop enforces the same rule for its own UI verbs in
// `desktop/src/main/integration/bench-guard.ts`. The rule is therefore stated
// twice on purpose, and both sides carry a test pinning identical behaviour
// (root match, subdirectory match, sibling-prefix rejection).
//
// See docs/architecture/adr/024-integration-workspace.md § "The bench refuses
// history writes" for the design framing.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

/**
 * Gate decision. `block: false` means the command passes; `block: true`
 * carries a user-facing reason string.
 */
export interface BenchGateDecision {
  block: boolean
  /** The bench directory that triggered the refusal. */
  benchPath?: string
  /** The git subcommand that would have written history. */
  subcommand?: string
  reason?: string
}

/**
 * Git subcommands that write history, move a branch, or publish.
 *
 * Each of these either creates a commit the next rebuild destroys, publishes a
 * synthetic merge, moves the bench branch out from under the rebuild's
 * `switch -C`, or anchors a synthetic commit behind a ref that outlives the
 * rebuild. `pull` is included because it is fetch-plus-merge: it writes history
 * exactly like `merge` does, and a rebuild discards the result. `tag` is
 * included because a tag on a bench commit both survives the rebuild that
 * destroys its target and is pushable.
 *
 * Deliberately ABSENT: `add`, `rm`, `restore`, `clean`, and `apply`. Those
 * touch the index and working tree rather than history, `--discard-changes`
 * already resets them on the next rebuild, and refusing them would stop the
 * operator inspecting or tidying a bench tree — `apply` in particular is how
 * hunk-level staging works, so blocking it would break diff review in the one
 * place the bench exists to serve. Also absent: every read verb (`status`,
 * `log`, `diff`, `show`, `blame`, …).
 *
 * Over-blocking is as much a defect as under-blocking here: the bench's only
 * purpose is to build and test, so anything that does not risk losing work or
 * publishing someone else's in-flight commits must pass.
 */
const HISTORY_WRITING_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'commit',
  'push',
  'pull',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'reset',
  'branch',
  'checkout',
  'switch',
  'stash',
  'tag',
  'am',
  'filter-branch',
])

/**
 * Git global options that consume the FOLLOWING token as their value. They
 * must be skipped in pairs to reach the real subcommand, so
 * `git -C /repo commit` resolves to `commit` and not to `/repo`.
 */
const VALUE_TAKING_GLOBAL_OPTS: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
])

/**
 * Decide whether `command` should be refused because it writes git history
 * inside a bench.
 *
 * Two independent conditions must both hold, and they are checked in the
 * cheaper-first order:
 *
 *   1. `cwd` is inside a bench directory. If not, every git write is fine —
 *      an ordinary worktree is exactly where commits belong.
 *   2. The command invokes a history-writing git subcommand. If not, it is a
 *      read, a build, or a test, all of which the bench exists to serve.
 *
 * A chained command is refused when ANY of its git invocations writes history,
 * so `git add -A && git commit -m x` is refused on the `commit`.
 */
export function gateBenchCommand(command: string, cwd: string): BenchGateDecision {
  if (!command || !cwd) return { block: false }
  if (!isBenchDirectory(cwd)) return { block: false }

  const benchPath = resolveBenchFor(cwd)
  for (const subcommand of extractGitSubcommands(command)) {
    if (HISTORY_WRITING_SUBCOMMANDS.has(subcommand)) {
      return {
        block: true,
        benchPath: benchPath ?? cwd,
        subcommand,
        reason: formatBlockReason(subcommand, benchPath ?? cwd),
      }
    }
  }
  return { block: false }
}

/**
 * True when `path` is a bench directory or any descendant of one.
 *
 * The separator is REQUIRED on the descendant check. A bare
 * `path.startsWith(bench)` would match a sibling whose name merely begins with
 * the bench path (`…/project-josh-other` against `…/project-josh`), refusing
 * commits in an unrelated worktree — a false refusal in exactly the place the
 * operator is trying to do real work.
 */
export function isBenchDirectory(path: string): boolean {
  return resolveBenchFor(path) !== null
}

/**
 * Resolve which bench contains `path`, or null when none does.
 *
 * Returning the bench path (rather than a bare boolean) lets the refusal name
 * the specific directory, which is what makes the message actionable.
 */
function resolveBenchFor(path: string): string | null {
  if (!path) return null
  for (const benchPath of loadBenchPaths()) {
    if (path === benchPath) return benchPath
    if (path.startsWith(benchPath + sep)) return benchPath
  }
  return null
}

/**
 * Extract the subcommand of every git invocation in `command`.
 *
 * Handles the shapes an agent actually produces:
 *   - `git commit -m "x"`                → ['commit']
 *   - `cd /somewhere && git push`        → ['push']
 *   - `git -C /repo commit -m "x"`       → ['commit']   (skips the -C pair)
 *   - `git -c user.name=X commit`        → ['commit']   (skips the -c pair)
 *   - `/usr/bin/git status`              → ['status']   (absolute git path)
 *   - `git add -A && git commit -m "x"`  → ['add', 'commit']  (both)
 *   - `npm run build`                    → []
 *
 * Returns the subcommands in invocation order. A command with no git call
 * returns an empty list, which the gate treats as "nothing to refuse".
 */
export function extractGitSubcommands(command: string): string[] {
  const found: string[] = []

  for (const segment of splitOnShellOperators(command)) {
    const tokens = tokenize(segment)
    for (let i = 0; i < tokens.length; i++) {
      if (!isGitExecutable(tokens[i])) continue
      const subcommand = readSubcommand(tokens, i + 1)
      if (subcommand) found.push(subcommand)
    }
  }

  return found
}

/**
 * True when a token is the git executable: bare `git`, or any path ending in
 * `/git` (`/usr/bin/git`, `/opt/homebrew/bin/git`).
 *
 * Matched on the exact basename so a token like `gitleaks` or `git-crypt` —
 * different programs that do not take git subcommands — is not mistaken for
 * git and does not produce a phantom refusal.
 */
function isGitExecutable(token: string): boolean {
  if (!token) return false
  const base = token.split('/').pop()
  return base === 'git'
}

/**
 * Walk forward from the token after `git` and return the first token that is
 * the subcommand, skipping global options.
 *
 * Value-taking options (`-C <path>`, `-c <k=v>`) consume the next token too;
 * `--opt=value` forms are self-contained and consume only themselves.
 */
function readSubcommand(tokens: string[], start: number): string | null {
  let i = start
  while (i < tokens.length) {
    const token = tokens[i]
    if (!token.startsWith('-')) return token
    // `--git-dir=/x` carries its value inline, so only this token is consumed.
    if (token.includes('=')) { i += 1; continue }
    i += VALUE_TAKING_GLOBAL_OPTS.has(token) ? 2 : 1
  }
  return null
}

/**
 * Split a command line on shell operators that separate independent commands
 * (`&&`, `||`, `;`, `|`, newline).
 *
 * Quoted regions are preserved verbatim: an operator inside quotes
 * (`git commit -m "a && b"`) is part of an argument, not a separator, and
 * splitting there would invent a second command that does not exist.
 */
function splitOnShellOperators(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]

    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    // Two-character operators first, so `&&` is not read as two `&`.
    const pair = command.slice(i, i + 2)
    if (pair === '&&' || pair === '||') {
      segments.push(current)
      current = ''
      i += 1
      continue
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') {
      segments.push(current)
      current = ''
      continue
    }
    current += ch
  }

  segments.push(current)
  return segments.filter((s) => s.trim().length > 0)
}

/**
 * Split a single command segment into tokens on whitespace, honouring quotes
 * and stripping the surrounding quote characters.
 *
 * Quote handling matters for correctness rather than cosmetics: without it,
 * `git commit -m "two words"` would tokenize the message into separate tokens
 * and a subcommand scan could read one of them as a git argument.
 */
function tokenize(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false

  for (const ch of segment) {
    if (quote) {
      if (ch === quote) { quote = null; continue }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue }
    if (ch === ' ' || ch === '\t') {
      if (started) { tokens.push(current); current = ''; started = false }
      continue
    }
    current += ch
    started = true
  }
  if (started) tokens.push(current)

  return tokens
}

// ─── Bench path resolution ────────────────────────────────────────────────

/**
 * Cached bench paths, read from the desktop's workspace record.
 *
 * Lifetime is the extension subprocess lifetime. The cache is purely an
 * optimisation — the `tool_call` hook is on the critical path of every Bash
 * call, and re-reading and re-parsing a JSON file per call would be wasteful.
 *
 * `null` means "not yet loaded" and is distinct from `[]`, which means "loaded
 * and there are no benches". Without that distinction a machine with no
 * benches would re-read the file on every single tool call.
 */
let benchPathCache: string[] | null = null

/**
 * Reset the bench path cache. Exported for tests; not used in production code.
 */
export function _resetBenchCacheForTests(): void {
  benchPathCache = null
}

/**
 * Read the bench paths from `~/.ion/integration-workspaces.json`.
 *
 * The home directory is resolved LAZILY on every load rather than captured at
 * module load. A module-level `const` would freeze whatever HOME was when the
 * module first loaded, which makes the path unobservable and would send a test
 * that redirects HOME to the developer's real `~/.ion`. The desktop's
 * `bench-store.ts` carries the same rule for the same reason.
 *
 * FAILS OPEN on every error path — missing file, unreadable file, malformed
 * JSON, unexpected shape. An empty list means "no benches known", so the gate
 * refuses nothing. That direction is deliberate: a false refusal would block
 * legitimate commits in an ordinary worktree, which is a worse outcome than
 * missing the guard until the file is readable again. The desktop UI enforces
 * the same rule independently, so a transient read failure here does not leave
 * the bench completely unguarded.
 */
function loadBenchPaths(): string[] {
  if (benchPathCache !== null) return benchPathCache

  const file = join(homedir(), '.ion', 'integration-workspaces.json')
  if (!existsSync(file)) {
    benchPathCache = []
    return benchPathCache
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    const workspaces = (parsed as { workspaces?: unknown })?.workspaces
    if (!Array.isArray(workspaces)) {
      benchPathCache = []
      return benchPathCache
    }
    benchPathCache = workspaces
      .map((w) => (w as { benchPath?: unknown })?.benchPath)
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
  } catch {
    // Malformed JSON, a permission error, or a partially-written file. Fail
    // open, per the rule above. There is no logger in this module (it is a
    // pure helper with no engine dependency); index.ts logs the gate decision
    // it receives, which is where the observable signal belongs.
    benchPathCache = []
  }

  return benchPathCache
}

/**
 * Build the LLM-readable refusal message.
 *
 * The reason flows back to the LLM as the tool-call result, so it must say what
 * to do INSTEAD — a refusal that only says "no" gets retried verbatim. The
 * remediation is always the same: the fix belongs in the member worktree that
 * owns the file, because that is the only place a commit survives.
 */
export function formatBlockReason(subcommand: string, benchPath: string): string {
  return [
    `ion-meta refused this \`git ${subcommand}\` because \`${benchPath}\` is an integration bench.`,
    'A bench branch is recreated from scratch on every rebuild, so a commit made here is destroyed by the next rebuild and a push would publish a synthetic merge of other people\'s in-flight work.',
    'Apply this change in the member worktree that owns the file and commit it there, then update that member in the bench.',
    'Reading, building, and testing in the bench are unaffected.',
  ].join(' ')
}
