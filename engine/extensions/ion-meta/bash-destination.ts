// Literal destination resolution for a `Bash` command string.
//
// Why this module exists
// ---------------------
// A worktree conversation is supposed to write only inside its own worktree.
// The containment gate (worktree-gate.ts) knew the session's cwd but nothing
// about the command body, so a command whose cwd was the worktree passed the
// gate and was then free to `cd` somewhere else and commit there. That is not
// hypothetical: a conversation whose cwd was `~/.ion/worktrees/ion-03e81090`
// ran 115 commands prefixed `cd /Users/Shared/source/personal/ion &&`, and two
// commits landed on the base repo's branch instead of the worktree's. The
// worktree's own reflog showed only its creation entries.
//
// This module reads the command text and reports every directory the command
// can be PROVEN to operate in.
//
// The "literal only" rule, and why it is the whole design
// ------------------------------------------------------
// A destination is reported only when it is read from the command as a literal
// path. Anything dynamic — `cd "$TARGET"`, `cd $(git rev-parse --show-toplevel)`,
// a path built from a backtick substitution — is NOT resolved. It is recorded as
// an `unresolvedHint` and the session cwd stands.
//
// That asymmetry is deliberate. A caller can only refuse when this module has
// positively resolved a literal path, so a false refusal in the operator's own
// working directory is structurally impossible rather than merely unlikely. The
// cost is that dynamic forms are a silent miss, which is why the unresolved case
// is reported rather than dropped: the caller logs it, and the residual gap is
// queryable instead of invisible.
//
// The alternative — refusing whenever the destination cannot be resolved — was
// rejected. It would refuse `cd $(git rev-parse --show-toplevel)`, per-directory
// loops, and any command invoking a script that might `cd` internally, all of
// which are legitimate work inside the operator's own worktree. It also buys no
// closure: `eval`, `bash -c` with a constructed string, and a make target that
// changes directory defeat any command-string parser. Closing that residual gap
// needs process-level containment, which is a different mechanism; this module
// does not pretend to reach it.
//
// Scope: this module answers "where could this command write". It has no opinion
// about whether that location is allowed — that is the caller's policy.

import { isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'

/** Every directory a `Bash` command was proven to operate in. */
export interface BashDestination {
  /**
   * Distinct directories the command operates in, session cwd first.
   *
   * Always contains at least the session cwd, so a caller can treat this as a
   * total replacement for "just use the cwd" without a null case.
   */
  paths: string[]
  /**
   * True when at least one destination beyond the session cwd was read
   * literally from the command text.
   */
  resolvedLiteral: boolean
  /**
   * The first destination-changing construct that could NOT be read literally,
   * verbatim (e.g. `cd "$TARGET"`). Absent when everything resolved.
   *
   * Present-and-passing is the honest state of the residual gap: the caller
   * logs it so a dynamic-form escape is found by log query rather than by
   * discovering its consequences later.
   */
  unresolvedHint?: string
}

/**
 * Shell operators that end one command and begin another.
 *
 * `|` is included because a pipeline's right-hand side is a separate command
 * that may itself `cd`. Order matters: two-character operators are tested
 * before `|` so `||` is never mistaken for two pipes.
 */
const SEGMENT_OPERATORS = ['&&', '||', ';', '|', '&'] as const

/**
 * Resolve every directory `command` can be proven to operate in.
 *
 * `cd` and `pushd` are SEQUENTIAL: a `cd` in one segment changes the directory
 * every later segment runs in, which is exactly why `cd /repo && git commit`
 * commits in `/repo`. `git -C` is per-invocation and does not affect later
 * segments.
 */
export function resolveBashDestination(command: string, sessionCwd: string): BashDestination {
  const base = sessionCwd || process.cwd()
  const paths: string[] = [base]
  let resolvedLiteral = false
  let unresolvedHint: string | undefined

  // Tracks the directory subsequent segments run in, mutated by `cd`/`pushd`.
  let current = base

  const record = (p: string): void => {
    if (!paths.includes(p)) paths.push(p)
  }

  if (!command || typeof command !== 'string') {
    return { paths, resolvedLiteral }
  }

  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment)
    if (tokens.length === 0) continue

    // ── cd / pushd: changes the directory for this and every later segment ──
    if (tokens[0] === 'cd' || tokens[0] === 'pushd') {
      const raw = firstNonFlag(tokens.slice(1))
      // A bare `cd` (or `cd -`, `cd ~`) goes somewhere this parser will not
      // guess at. Leave `current` alone; the cwd already stands.
      if (raw === undefined || raw === '-') continue
      const literal = asLiteralPath(raw)
      if (literal === undefined) {
        // Dynamic destination. The cwd stands, and the construct is reported so
        // the gap is observable. First one wins: one hint is enough to send a
        // reader to the command, and the whole command is logged with it.
        if (unresolvedHint === undefined) unresolvedHint = segment.trim()
        continue
      }
      current = absolutise(literal, current)
      resolvedLiteral = true
      record(current)
      continue
    }

    // ── git -C / --git-dir / --work-tree: per-invocation redirection ──
    if (tokens[0] === 'git') {
      const redirect = gitRedirect(tokens)
      if (redirect === 'unresolved') {
        if (unresolvedHint === undefined) unresolvedHint = segment.trim()
        continue
      }
      if (redirect !== undefined) {
        resolvedLiteral = true
        record(absolutise(redirect, current))
        continue
      }
    }

    // Any other command runs in `current`, which is already recorded (it is
    // either `base` or was recorded when the `cd` that set it resolved).
  }

  return { paths, resolvedLiteral, unresolvedHint }
}

/**
 * Split a command into segments on shell control operators, respecting quotes.
 *
 * A hand-rolled scanner rather than `String.split`: splitting on a bare `&&`
 * would cut inside `git commit -m "a && b"` and mis-attribute the remainder.
 * Quote tracking is the minimum needed to avoid that.
 */
function splitSegments(command: string): string[] {
  const segments: string[] = []
  let buf = ''
  let quote: '"' | "'" | null = null

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]

    // A backslash-escaped character is literal and never a delimiter.
    if (ch === '\\' && i + 1 < command.length) {
      buf += ch + command[i + 1]
      i++
      continue
    }

    if (quote) {
      buf += ch
      if (ch === quote) quote = null
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      continue
    }

    const op = SEGMENT_OPERATORS.find((o) => command.startsWith(o, i))
    if (op) {
      segments.push(buf)
      buf = ''
      i += op.length - 1
      continue
    }

    buf += ch
  }

  segments.push(buf)
  return segments.filter((s) => s.trim().length > 0)
}

/**
 * Split a segment into whitespace-separated tokens, respecting quotes.
 *
 * Quotes are PRESERVED in the token so `asLiteralPath` can tell `cd "$X"`
 * (dynamic) from `cd "/some path"` (literal with a space).
 */
function tokenize(segment: string): string[] {
  const tokens: string[] = []
  let buf = ''
  let quote: '"' | "'" | null = null

  const flush = (): void => {
    if (buf.length > 0) {
      tokens.push(buf)
      buf = ''
    }
  }

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]

    if (ch === '\\' && i + 1 < segment.length) {
      buf += ch + segment[i + 1]
      i++
      continue
    }

    if (quote) {
      buf += ch
      if (ch === quote) quote = null
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      continue
    }

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      flush()
      continue
    }

    buf += ch
  }

  flush()
  return tokens
}

/** First token that is not a `-flag`, or undefined when there is none. */
function firstNonFlag(tokens: string[]): string | undefined {
  for (const t of tokens) {
    if (t === '--') continue
    if (t.startsWith('-') && t !== '-') continue
    return t
  }
  return undefined
}

/**
 * The directory a `git` invocation is redirected to.
 *
 * Returns the literal path, `'unresolved'` when a redirect flag is present with
 * a dynamic value, or undefined when the invocation is not redirected at all.
 *
 * `--git-dir` and `--work-tree` are included alongside `-C` because all three
 * are ways to commit somewhere other than the cwd, which is the behaviour being
 * gated.
 */
function gitRedirect(tokens: string[]): string | 'unresolved' | undefined {
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]

    if (t === '-C') {
      const value = tokens[i + 1]
      if (value === undefined) return undefined
      return asLiteralPath(value) ?? 'unresolved'
    }

    for (const flag of ['--git-dir', '--work-tree']) {
      if (t === flag) {
        const value = tokens[i + 1]
        if (value === undefined) return undefined
        return asLiteralPath(value) ?? 'unresolved'
      }
      if (t.startsWith(`${flag}=`)) {
        return asLiteralPath(t.slice(flag.length + 1)) ?? 'unresolved'
      }
    }

    // The first bare token after `git` is the subcommand; redirect flags all
    // precede it, so there is nothing further to find.
    if (!t.startsWith('-')) return undefined
  }
  return undefined
}

/**
 * Reduce a raw token to a literal path, or undefined when it is dynamic.
 *
 * Dynamic markers are `$` (variable or `$(...)`) and a backtick substitution.
 * A leading `~` IS resolved, because the home directory is knowable and
 * `cd ~/Downloads` is a common, entirely literal destination.
 */
function asLiteralPath(token: string): string | undefined {
  let t = token

  // Strip one layer of matched surrounding quotes. Done before the dynamic
  // check so `"$TARGET"` is still recognised as dynamic.
  if (t.length >= 2) {
    const first = t[0]
    const last = t[t.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      t = t.slice(1, -1)
    }
  }

  if (t === '') return undefined
  if (t.includes('$') || t.includes('`')) return undefined

  // Unescape backslash-escaped spaces and quotes so the path matches the
  // filesystem (`cd /some\ dir` -> `/some dir`).
  t = t.replace(/\\(.)/g, '$1')

  if (t === '~') return homedir()
  if (t.startsWith('~/')) return resolve(homedir(), t.slice(2))

  return t
}

function absolutise(p: string, base: string): string {
  return isAbsolute(p) ? p : resolve(base || process.cwd(), p)
}
