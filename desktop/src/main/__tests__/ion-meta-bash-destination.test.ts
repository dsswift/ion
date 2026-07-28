/**
 * Bash destination resolution tests.
 *
 * The resolver answers "which directories can this command be PROVEN to operate
 * in". Two properties matter and both are pinned here:
 *
 *   1. Every literal destination is found — a `cd` anywhere in the chain, a
 *      `git -C`, a relative path, a `~` path. Missing one is how a command
 *      escapes its worktree unnoticed.
 *   2. A dynamic destination is NEVER guessed. It is reported as unresolved so
 *      the caller passes the call and logs the gap. Guessing would produce false
 *      refusals in the operator's own working directory, which is a worse defect
 *      than the one the resolver exists to catch.
 */
import { describe, it, expect, vi } from 'vitest'

const HOME = '/tmp/ion-bd-home'

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => HOME }
})

import { resolveBashDestination } from '../../../../engine/extensions/ion-meta/bash-destination'

const CWD = '/work/wt/feature-a'

describe('resolveBashDestination — the session cwd is always present', () => {
  it('returns the cwd for a command with no destination change', () => {
    const d = resolveBashDestination('npm test', CWD)
    expect(d.paths).toEqual([CWD])
    expect(d.resolvedLiteral).toBe(false)
    expect(d.unresolvedHint).toBeUndefined()
  })

  it('falls back to process.cwd() when no cwd is supplied', () => {
    const d = resolveBashDestination('npm test', '')
    expect(d.paths).toEqual([process.cwd()])
  })

  it('handles an empty command without throwing', () => {
    expect(resolveBashDestination('', CWD).paths).toEqual([CWD])
  })
})

describe('resolveBashDestination — literal cd resolution', () => {
  it('resolves an absolute cd', () => {
    const d = resolveBashDestination('cd /other/repo && git commit -m x', CWD)
    expect(d.paths).toEqual([CWD, '/other/repo'])
    expect(d.resolvedLiteral).toBe(true)
  })

  it('resolves a relative cd against the cwd', () => {
    const d = resolveBashDestination('cd desktop && npm test', CWD)
    expect(d.paths).toEqual([CWD, '/work/wt/feature-a/desktop'])
  })

  it('resolves a relative cd that climbs out', () => {
    const d = resolveBashDestination('cd ../../base && git commit -m x', CWD)
    expect(d.paths).toEqual([CWD, '/work/base'])
  })

  it('applies cd sequentially, so later segments inherit the new directory', () => {
    // This is why a `cd` matters at all: `git commit` in segment two runs in the
    // directory segment one moved to.
    const d = resolveBashDestination('cd /a && cd b && git commit -m x', CWD)
    expect(d.paths).toEqual([CWD, '/a', '/a/b'])
  })

  it('finds a cd that is not the first segment', () => {
    const d = resolveBashDestination('npm test && cd /other && touch x', CWD)
    expect(d.paths).toContain('/other')
  })

  it('resolves cd across ;, ||, |, and & separators', () => {
    expect(resolveBashDestination('echo a ; cd /s1', CWD).paths).toContain('/s1')
    expect(resolveBashDestination('false || cd /s2', CWD).paths).toContain('/s2')
    expect(resolveBashDestination('cat f | cd /s3', CWD).paths).toContain('/s3')
    expect(resolveBashDestination('sleep 1 & cd /s4', CWD).paths).toContain('/s4')
  })

  it('resolves pushd the same way as cd', () => {
    expect(resolveBashDestination('pushd /other && git log', CWD).paths).toContain('/other')
  })

  it('resolves a ~ destination against the home directory', () => {
    expect(resolveBashDestination('cd ~/Downloads && unzip a.zip', CWD).paths)
      .toEqual([CWD, `${HOME}/Downloads`])
    expect(resolveBashDestination('cd ~ && ls', CWD).paths).toEqual([CWD, HOME])
  })

  it('resolves a quoted literal path, including one containing a space', () => {
    expect(resolveBashDestination('cd "/other/repo" && ls', CWD).paths).toContain('/other/repo')
    expect(resolveBashDestination("cd '/other/my repo' && ls", CWD).paths).toContain('/other/my repo')
  })

  it('resolves a backslash-escaped space in an unquoted path', () => {
    expect(resolveBashDestination('cd /other/my\\ repo && ls', CWD).paths).toContain('/other/my repo')
  })

  it('skips flags to find the destination', () => {
    expect(resolveBashDestination('cd -P /other && ls', CWD).paths).toContain('/other')
  })

  it('leaves the directory alone for a bare cd or cd -', () => {
    // `cd` with no argument goes home and `cd -` goes back; neither is a
    // destination this resolver will assert, so the cwd stands.
    expect(resolveBashDestination('cd && ls', CWD).paths).toEqual([CWD])
    expect(resolveBashDestination('cd - && ls', CWD).paths).toEqual([CWD])
  })

  it('does not duplicate a destination that repeats', () => {
    const d = resolveBashDestination('cd /a && ls && cd /a && ls', CWD)
    expect(d.paths).toEqual([CWD, '/a'])
  })
})

describe('resolveBashDestination — git redirection flags', () => {
  it('resolves git -C', () => {
    const d = resolveBashDestination('git -C /other/repo commit -m x', CWD)
    expect(d.paths).toEqual([CWD, '/other/repo'])
    expect(d.resolvedLiteral).toBe(true)
  })

  it('resolves --git-dir and --work-tree in both spellings', () => {
    expect(resolveBashDestination('git --work-tree=/other add .', CWD).paths).toContain('/other')
    expect(resolveBashDestination('git --work-tree /other add .', CWD).paths).toContain('/other')
    expect(resolveBashDestination('git --git-dir=/other/.git log', CWD).paths).toContain('/other/.git')
  })

  it('does not treat a plain git invocation as redirected', () => {
    expect(resolveBashDestination('git commit -m x', CWD).paths).toEqual([CWD])
  })

  it('does not mistake a later -C for a redirect flag', () => {
    // `-C` after the subcommand is that subcommand's own flag (e.g.
    // `git diff -C`), not a repo redirect.
    expect(resolveBashDestination('git diff -C /other', CWD).paths).toEqual([CWD])
  })

  it('applies git -C relative to the directory a prior cd established', () => {
    const d = resolveBashDestination('cd /a && git -C sub commit -m x', CWD)
    expect(d.paths).toEqual([CWD, '/a', '/a/sub'])
  })

  it('does not let git -C leak into later segments', () => {
    // Unlike cd, -C is per-invocation: the segment after it runs in the cwd.
    const d = resolveBashDestination('git -C /a log && touch x', CWD)
    expect(d.paths).toEqual([CWD, '/a'])
  })
})

describe('resolveBashDestination — dynamic destinations are never guessed', () => {
  it('reports a variable destination as unresolved and adds no path', () => {
    const d = resolveBashDestination('cd "$TARGET" && touch x', CWD)
    expect(d.paths).toEqual([CWD])
    expect(d.resolvedLiteral).toBe(false)
    expect(d.unresolvedHint).toBe('cd "$TARGET"')
  })

  it('reports an unquoted variable and a bare $VAR suffix', () => {
    expect(resolveBashDestination('cd $TARGET && ls', CWD).unresolvedHint).toBe('cd $TARGET')
    expect(resolveBashDestination('cd /base/$NAME && ls', CWD).unresolvedHint).toBe('cd /base/$NAME')
  })

  it('reports a command substitution in both spellings', () => {
    expect(resolveBashDestination('cd $(git rev-parse --show-toplevel) && ls', CWD).unresolvedHint)
      .toContain('rev-parse')
    expect(resolveBashDestination('cd `pwd`/sub && ls', CWD).unresolvedHint).toContain('`pwd`')
  })

  it('reports an unresolvable git -C without adding a path', () => {
    const d = resolveBashDestination('git -C "$REPO" commit -m x', CWD)
    expect(d.paths).toEqual([CWD])
    expect(d.unresolvedHint).toBe('git -C "$REPO" commit -m x')
  })

  it('keeps the first unresolved hint when several are present', () => {
    const d = resolveBashDestination('cd $A && cd $B', CWD)
    expect(d.unresolvedHint).toBe('cd $A')
  })

  it('still resolves the literal destinations in a mixed command', () => {
    // A dynamic segment must not suppress the literal ones — that would hide a
    // real escape behind an unrelated variable.
    const d = resolveBashDestination('cd $UNKNOWN ; cd /other/repo && git commit -m x', CWD)
    expect(d.paths).toContain('/other/repo')
    expect(d.resolvedLiteral).toBe(true)
    expect(d.unresolvedHint).toBe('cd $UNKNOWN')
  })
})

describe('resolveBashDestination — quoting must not create false segments', () => {
  it('does not split on an operator inside a double-quoted string', () => {
    const d = resolveBashDestination('git commit -m "fix a && b"', CWD)
    expect(d.paths).toEqual([CWD])
    expect(d.unresolvedHint).toBeUndefined()
  })

  it('does not split on an operator inside a single-quoted string', () => {
    expect(resolveBashDestination("echo 'a ; b' && ls", CWD).paths).toEqual([CWD])
  })

  it('does not read a cd mentioned inside a quoted string as a real cd', () => {
    // The words are an argument to echo, not a command.
    const d = resolveBashDestination('echo "cd /other"', CWD)
    expect(d.paths).toEqual([CWD])
  })

  it('finds a real cd that follows a quoted operator', () => {
    const d = resolveBashDestination(`git commit -m "a && b" && cd /other`, CWD)
    expect(d.paths).toEqual([CWD, '/other'])
  })

  it('does not split on an escaped operator', () => {
    expect(resolveBashDestination('echo a \\&\\& b', CWD).paths).toEqual([CWD])
  })
})
