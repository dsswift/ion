/**
 * Literal destination resolution for a `Bash` command string — the desktop
 * port of the engine's resolver (engine/internal/workspaces/bash.go), used by
 * the client tool gate (bench-tool-policy.ts) to judge where a shell command
 * can be PROVEN to operate.
 *
 * ── The "literal only" rule, and why it is the whole design ─────────────────
 * A destination is reported only when it is read from the command as a literal
 * path. Anything dynamic — `cd "$TARGET"`, `cd $(git rev-parse
 * --show-toplevel)`, a path built from a backtick substitution — is NOT
 * resolved. It is recorded as an `unresolvedHint` and the session cwd stands.
 *
 * That asymmetry is deliberate. A caller can only refuse when this module has
 * positively resolved a literal path, so a false refusal in the operator's own
 * working directory is structurally impossible rather than merely unlikely.
 * The cost is that dynamic forms are a silent miss, which is why the
 * unresolved case is reported rather than dropped: the caller logs it at WARN,
 * and the residual gap is queryable instead of invisible.
 *
 * The alternative — refusing whenever the destination cannot be resolved — was
 * rejected. It would refuse `cd $(git rev-parse --show-toplevel)`,
 * per-directory loops, and any command invoking a script that might `cd`
 * internally, all of which are legitimate work in the conversation's own
 * worktree. It also buys no closure: `eval`, `bash -c` with a constructed
 * string, and a make target that changes directory defeat any command-string
 * parser. Closing that residual gap needs process-level containment, a
 * different mechanism; this module does not pretend to reach it.
 *
 * Scope: this module answers "where could this command write" and "which git
 * verbs does it invoke". It has no opinion about whether that location is
 * allowed — that is the caller's policy.
 */
import { basename, isAbsolute, join, normalize, sep } from 'node:path'

/** Merge-driver classification for one segment. */
export type MergeDriver = '' | 'continue' | 'abort'

/**
 * One parsed Git subcommand. Arguments exclude global Git options and the
 * subcommand itself, so policy never mistakes a commit message or shell token
 * for a destructive flag.
 */
export interface GitOperation {
  subcommand: string
  arguments: string[]
}

/**
 * One shell segment (between && / || / ; / | / newline) with the directory it
 * can be PROVEN to operate in and the Git subcommands it invokes.
 */
export interface BashSegment {
  /**
   * The literal working directory the segment operates in: the last literal
   * cd/pushd destination seen so far, or a per-invocation `git -C <dir>` /
   * `--work-tree=<dir>` target. Empty = session cwd.
   */
  dir: string
  /** The Git verbs the segment invokes, in order. */
  gitSubcommands: string[]
  /**
   * `continue` or `abort` when this segment drives an existing merge. Empty
   * for every other command.
   */
  mergeDriver: MergeDriver
  /**
   * True only when the complete Bash command matches the safe merge-driver
   * grammar parsed by parseExactMergeDriver. Detection of a driver attempt
   * remains separate so malformed calls receive an actionable exact-call
   * refusal instead of falling through to generic bench history.
   */
  mergeDriverExact: boolean
  /**
   * Each invocation's subcommand and arguments, so policy can distinguish
   * destructive forms such as `restore --staged` from reads.
   */
  gitOperations: GitOperation[]
}

/** The resolution result for one command string. */
export interface BashDestinations {
  segments: BashSegment[]
  /**
   * Records a destination-changing construct that could not be resolved
   * literally (`cd "$VAR"`, `cd $(...)`). The command PASSES — refusing would
   * block legitimate work in the conversation's own worktree — and the caller
   * logs the hint at WARN so the residual gap is queryable rather than
   * invisible.
   */
  unresolvedHint?: string
}

/**
 * Reports whether this operation changes what the worktree IS — which branch
 * it holds, or whether it exists at all.
 *
 * The list is deliberately tiny. An earlier revision refused every verb that
 * could theoretically detach HEAD (rebase, reset, stash, cherry-pick, amend,
 * push, branch -f), which broke the operator's own workflows: `/align` amends
 * a branch-local commit through `git stash` + `git rebase -i` + `git commit
 * --amend` + `git rebase --continue`, `/squash` rebuilds from `git reset
 * --soft {base}` behind a `git branch -f backup--<branch>` safety net, and
 * `/create-pr` pushes. Those are the sanctioned mechanisms, not accidents.
 * Here we refuse only what no in-worktree workflow legitimately does:
 * deliberately detaching HEAD, switching the checkout to another branch, or
 * removing the worktree out from under the conversation living in it.
 */
export function worktreeIdentityChange(op: GitOperation): { verb: string; changes: boolean } {
  switch (op.subcommand) {
    case 'checkout':
      // `--detach` is unambiguous intent to leave the assigned branch.
      // `-b`/`-B` create a branch AND move the checkout onto it.
      //
      // A bare `git checkout <token>` is NOT refused: it is ambiguous between
      // a ref and a pathspec, and the file-restore form (including restoring
      // a DELETED file, where the path no longer exists to probe) is ordinary
      // work. Guessing wrong there refuses real work in the operator's own
      // worktree.
      if (containsAny(op.arguments, '--detach')) return { verb: 'checkout --detach', changes: true }
      if (containsShortFlag(op.arguments, 'b', 'B')) return { verb: 'checkout -b', changes: true }
      return { verb: '', changes: false }
    case 'switch':
      // `switch` has no pathspec form — every invocation that names something
      // moves the checkout. `--continue`/`--abort` drive an in-progress
      // switch and are how one is unwound, so they pass.
      if (containsAny(op.arguments, '--continue', '--abort')) return { verb: '', changes: false }
      if (containsAny(op.arguments, '--detach')) return { verb: 'switch --detach', changes: true }
      if (op.arguments.length === 0) return { verb: '', changes: false }
      return { verb: 'switch', changes: true }
    case 'worktree':
      // `add` and `list` are fine — `/align` PR mode cuts a dedicated
      // worktree for PR fixes. `remove`/`move`/`prune` can delete or relocate
      // the directory a conversation is living in.
      for (const argument of op.arguments) {
        if (argument === 'remove' || argument === 'move' || argument === 'prune') {
          return { verb: `worktree ${argument}`, changes: true }
        }
      }
      return { verb: '', changes: false }
    default:
      return { verb: '', changes: false }
  }
}

function containsAny(values: string[], ...want: string[]): boolean {
  return values.some((value) => want.some((c) => value === c || value.startsWith(`${c}=`)))
}

function containsShortFlag(values: string[], ...flags: string[]): boolean {
  for (const value of values) {
    if (!value.startsWith('-') || value.startsWith('--')) continue
    for (const flag of flags) {
      if (value.slice(1).includes(flag)) return true
    }
  }
  return false
}

/**
 * Git global options that consume the FOLLOWING token as their value. They
 * must be skipped in pairs to reach the real subcommand, so `git -C /repo
 * commit` resolves to `commit`, not `/repo`.
 */
const VALUE_TAKING_GIT_GLOBALS: ReadonlySet<string> = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env',
])

/**
 * Resolve every literal destination and git invocation from a shell command.
 * Handles the shapes agents actually produce: `cd /x && git commit`,
 * `git -C /repo push`, `pushd dir; make`, absolute git paths
 * (`/usr/bin/git`), chained segments. Deliberately not a full shell parser —
 * `eval`, subshell trickery, and dynamic paths defeat any command-string
 * parser, and those pass with an unresolvedHint instead of guessing.
 */
export function resolveBashDestinations(command: string, cwd: string): BashDestinations {
  const out: BashDestinations = { segments: [] }

  for (const rawSegment of splitShellSegments(command)) {
    const tokens = tokenizeShell(rawSegment)
    if (tokens.length === 0) continue
    const seg: BashSegment = {
      dir: '', gitSubcommands: [], mergeDriver: '', mergeDriverExact: false, gitOperations: [],
    }
    // Carry the directory forward from the previous segment: `cd /x && git
    // commit` commits in /x, and the cd's effect persists across segment
    // boundaries within one command string.
    if (out.segments.length > 0) seg.dir = out.segments[out.segments.length - 1].dir

    for (let i = 0; i < tokens.length; i++) {
      const tok = normalizeGroupingToken(tokens[i])

      if (tok === 'cd' || tok === 'pushd') {
        if (i + 1 >= tokens.length) continue // bare `cd` = $HOME; not a containment concern
        const dest = tokens[i + 1]
        if (isDynamicToken(dest)) {
          out.unresolvedHint = `${tok} ${dest}`
          continue
        }
        seg.dir = absolutize(dest, effectiveDir(seg.dir, cwd))
        i++
        continue
      }

      if (!isGitExecutable(tok)) continue

      // Walk the git invocation: skip global options (value-taking ones
      // consume the next token), capture -C/--work-tree destinations, then
      // read the subcommand.
      let gitDir = ''
      let j = i + 1
      while (j < tokens.length) {
        const t = tokens[j]
        if (!t.startsWith('-')) break
        if (t === '-C' || t === '--work-tree') {
          if (j + 1 < tokens.length) {
            const dest = tokens[j + 1]
            if (isDynamicToken(dest)) {
              out.unresolvedHint = `git ${t} ${dest}`
            } else {
              gitDir = absolutize(dest, effectiveDir(seg.dir, cwd))
            }
            j += 2
            continue
          }
          j++
          continue
        }
        const eq = t.indexOf('=')
        if (eq > 0) {
          // `--git-dir=/x`, `--work-tree=/x` carry the value inline.
          if (t.slice(0, eq) === '--work-tree') {
            const dest = t.slice(eq + 1)
            if (isDynamicToken(dest)) {
              out.unresolvedHint = `git ${t}`
            } else {
              gitDir = absolutize(dest, effectiveDir(seg.dir, cwd))
            }
          }
          j++
          continue
        }
        if (VALUE_TAKING_GIT_GLOBALS.has(t)) {
          j += 2
          continue
        }
        j++
      }
      if (j >= tokens.length) break
      const sub = tokens[j]
      if (isDynamicToken(sub)) {
        out.unresolvedHint = `git ${sub}`
        i = j
        continue
      }
      seg.gitSubcommands.push(sub)
      const op: GitOperation = { subcommand: sub, arguments: tokens.slice(j + 1) }
      seg.gitOperations.push(op)
      if (sub === 'merge') {
        for (let t of tokens.slice(j + 1)) {
          t = t.replace(/[)}]+$/, '')
          let driver = false
          if (t === '--continue') { driver = true; seg.mergeDriver = 'continue' }
          else if (t === '--abort') { driver = true; seg.mergeDriver = 'abort' }
          else if (t === '--quit') { driver = true } // detected, never classified — falls to generic history
          if (driver) break
        }
      }
      // A per-invocation `git -C <dir>` names where THIS invocation runs
      // without changing the segment's cd state: judge it as its own segment
      // so the destination is not lost.
      if (gitDir !== '' && gitDir !== seg.dir) {
        out.segments.push({
          dir: gitDir,
          gitSubcommands: [sub],
          mergeDriver: seg.mergeDriver,
          mergeDriverExact: false,
          gitOperations: [op],
        })
        // Remove it from the ambient segment: it was judged above.
        seg.gitSubcommands.pop()
        seg.gitOperations.pop()
      }
      i = j
    }

    out.segments.push(seg)
  }

  // Quoted-fallback detection: `sh -c 'git merge --continue'` hides the git
  // tokens inside one quoted span, so no segment classifies a driver — yet the
  // attempt must remain DETECTABLE so the turn-isolation and exact-call rules
  // still see it rather than letting quoting bypass them.
  if (!out.segments.some((s) => s.mergeDriver !== '')) {
    const driver = detectQuotedMergeDriverAttempt(command)
    if (driver !== '') {
      out.segments.push({
        dir: '', gitSubcommands: [], mergeDriver: driver, mergeDriverExact: false, gitOperations: [],
      })
    }
  }
  for (const segment of out.segments) {
    if (segment.mergeDriver !== '') {
      const { driver, exact } = parseExactMergeDriver(command)
      segment.mergeDriverExact = exact && driver === segment.mergeDriver
    }
  }
  return out
}

function detectQuotedMergeDriverAttempt(command: string): MergeDriver {
  if (command.includes('--continue') && command.includes('merge')) return 'continue'
  if (command.includes('--abort') && command.includes('merge')) return 'abort'
  return ''
}

/**
 * Git supports these value-free global options before its subcommand; anything
 * else outside the value-taking set fails the exact grammar.
 */
const VALUE_FREE_GIT_GLOBALS: ReadonlySet<string> = new Set([
  '--bare', '--no-pager', '--paginate', '-p', '--no-replace-objects', '--literal-pathspecs',
  '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-advice',
])

/**
 * Accepts only one simple shell command containing a git executable,
 * recognized git global options, `merge`, and exactly one driver argument.
 * Shell syntax is rejected before token parsing so quoting cannot hide command
 * substitution, redirection, backgrounding, grouping, or control flow.
 */
export function parseExactMergeDriver(command: string): { driver: MergeDriver; exact: boolean } {
  if (command.trim() === '' || containsUnsafeMergeDriverShell(command)) return { driver: '', exact: false }
  const tokens = tokenizeShell(command)
  if (tokens.length < 3 || !isGitExecutable(tokens[0])) return { driver: '', exact: false }

  let j = 1
  while (j < tokens.length && tokens[j].startsWith('-')) {
    const option = tokens[j]
    const eq = option.indexOf('=')
    if (eq > 0) {
      if (!VALUE_TAKING_GIT_GLOBALS.has(option.slice(0, eq)) || eq === option.length - 1) {
        return { driver: '', exact: false }
      }
      j++
      continue
    }
    if (VALUE_TAKING_GIT_GLOBALS.has(option)) {
      if (j + 1 >= tokens.length) return { driver: '', exact: false }
      j += 2
      continue
    }
    if (VALUE_FREE_GIT_GLOBALS.has(option)) {
      j++
      continue
    }
    return { driver: '', exact: false }
  }
  if (j >= tokens.length || tokens[j] !== 'merge' || tokens.length !== j + 2) {
    return { driver: '', exact: false }
  }
  switch (tokens[j + 1]) {
    case '--continue': return { driver: 'continue', exact: true }
    case '--abort': return { driver: 'abort', exact: true }
    default: return { driver: '', exact: false }
  }
}

/**
 * Rejects shell metacharacters that could smuggle work into an "exact" merge
 * driver call: outside quotes everything dangerous is rejected; inside double
 * quotes `$`, backtick, and backslash still expand and are rejected; single
 * quotes are inert. An unterminated quote is unsafe by definition.
 */
export function containsUnsafeMergeDriverShell(command: string): boolean {
  let quote = ''
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote === "'") {
      if (ch === "'") quote = ''
      continue
    }
    if (quote === '"') {
      if (ch === '"') { quote = ''; continue }
      if (ch === '$' || ch === '`' || ch === '\\') return true
      continue
    }
    switch (ch) {
      case "'":
      case '"':
        quote = ch
        break
      case '$': case '`': case '\\': case '&': case '|': case ';':
      case '<': case '>': case '(': case ')': case '{': case '}':
      case '\n': case '\r':
        return true
    }
  }
  return quote !== ''
}

/** The directory a segment effectively operates in: its own dir, else cwd. */
export function effectiveDir(segDir: string, cwd: string): string {
  return segDir !== '' ? segDir : cwd
}

/** Lexically clean a path, matching Go's filepath.Clean (no trailing sep). */
function clean(p: string): string {
  const n = normalize(p)
  if (n.length > 1 && n.endsWith(sep)) return n.slice(0, -1)
  return n
}

function absolutize(path: string, base: string): string {
  const stripped = path.replace(/^["']+|["']+$/g, '')
  if (isAbsolute(stripped)) return clean(stripped)
  if (base === '') return ''
  return clean(join(base, stripped))
}

/**
 * Whether a token's value cannot be known statically: variable expansion,
 * command substitution, backticks, tilde (whose expansion depends on the
 * executing user), or glob characters.
 */
function isDynamicToken(tok: string): boolean {
  return /[$`~*?]/.test(tok)
}

function normalizeGroupingToken(token: string): string {
  return token.replace(/^[({]+/, '')
}

/**
 * Matches bare `git` and any path ending in /git (`/usr/bin/git`). Matched on
 * the exact basename so `gitleaks` or `git-crypt` — different programs that do
 * not take git subcommands — are not mistaken for git and do not produce
 * phantom refusals.
 */
function isGitExecutable(tok: string): boolean {
  const stripped = tok.replace(/^["']+|["']+$/g, '')
  if (stripped === '') return false
  return basename(stripped) === 'git'
}

/**
 * Split a command on shell operators that create command boundaries (&&, ||,
 * &, ;, |, newline), respecting single and double quotes. Parentheses and
 * braces are retained in segments: recognizing their complete shell grammar
 * safely requires a full parser, while operators inside them still expose
 * compound merge-driver calls conservatively.
 */
function splitShellSegments(command: string): string[] {
  const segments: string[] = []
  let cur = ''
  let quote = ''

  const flush = (): void => {
    const s = cur.trim()
    if (s !== '') segments.push(s)
    cur = ''
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote !== '') {
      cur += ch
      if (ch === quote) quote = ''
      continue
    }
    switch (ch) {
      case "'":
      case '"':
        quote = ch
        cur += ch
        break
      case '\n':
      case ';':
        flush()
        break
      case '&':
        flush()
        if (i + 1 < command.length && command[i + 1] === '&') i++
        break
      case '|':
        if (i + 1 < command.length && command[i + 1] === '|') i++
        flush()
        break
      default:
        cur += ch
    }
  }
  flush()
  return segments
}

/**
 * Split one segment into tokens, keeping quoted spans as single tokens (with
 * quotes retained; absolutize strips them). A quoted commit message must not
 * tokenize into separate words that could be mistaken for subcommands.
 */
function tokenizeShell(segment: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let quote = ''

  const flush = (): void => {
    if (cur.length > 0) {
      tokens.push(cur)
      cur = ''
    }
  }

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (quote !== '') {
      cur += ch
      if (ch === quote) quote = ''
      continue
    }
    switch (ch) {
      case "'":
      case '"':
        quote = ch
        cur += ch
        break
      case ' ':
      case '\t':
        flush()
        break
      default:
        cur += ch
    }
  }
  flush()
  return tokens
}
