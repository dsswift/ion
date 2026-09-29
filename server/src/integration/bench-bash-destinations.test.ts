/**
 * Destination-resolver tests — ported from the engine's
 * engine/internal/workspaces/bash_test.go so the desktop's parser and the
 * Go original pin identical behaviour: segment splitting, cd chains, git -C,
 * quoted spans, dynamic-token hints, and the exact merge-driver grammar.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveBashDestinations, parseExactMergeDriver, worktreeIdentityChange,
  containsUnsafeMergeDriverShell,
} from './bench-bash-destinations'

const CWD = '/cwd'

describe('segment splitting and cd tracking', () => {
  it('resolves a cd destination and carries it into later segments', () => {
    const dest = resolveBashDestinations('cd /repo && git commit -m x', CWD)
    expect(dest.segments).toHaveLength(2)
    expect(dest.segments[0].dir).toBe('/repo')
    // The cd's effect persists across segment boundaries within one command.
    expect(dest.segments[1].dir).toBe('/repo')
    expect(dest.segments[1].gitSubcommands).toEqual(['commit'])
  })

  it('cd persists across ; segments', () => {
    const dest = resolveBashDestinations('cd /repo; echo ok; git status', CWD)
    expect(dest.segments[dest.segments.length - 1].dir).toBe('/repo')
    expect(dest.segments[dest.segments.length - 1].gitSubcommands).toEqual(['status'])
  })

  it('pushd resolves like cd', () => {
    const dest = resolveBashDestinations('pushd /sibling; make build', CWD)
    expect(dest.segments[0].dir).toBe('/sibling')
  })

  it('relative cd resolves against the cwd', () => {
    const dest = resolveBashDestinations('cd .. && git commit -m x', '/repo/wt-a')
    expect(dest.segments[0].dir).toBe('/repo')
  })

  it('relative cd resolves against an earlier cd, not the session cwd', () => {
    const dest = resolveBashDestinations('cd /a/b && cd sub && git status', CWD)
    expect(dest.segments[1].dir).toBe('/a/b/sub')
  })

  it('quoted operators do not split segments', () => {
    const dest = resolveBashDestinations('git commit -m "fix a && b"', CWD)
    expect(dest.segments).toHaveLength(1)
    expect(dest.segments[0].gitSubcommands).toEqual(['commit'])
  })

  it('a quoted commit message never tokenizes into subcommands', () => {
    const dest = resolveBashDestinations('git commit -m "push merge rebase"', CWD)
    expect(dest.segments[0].gitSubcommands).toEqual(['commit'])
  })
})

describe('git invocation parsing', () => {
  const cases: Array<[string, string[]]> = [
    ['git commit -m x', ['commit']],
    ['git -C /repo commit -m x', ['commit']], // skips the -C pair
    ['git -c user.name=X commit', ['commit']], // skips the -c pair
    ['/usr/bin/git status', ['status']], // absolute git path
    ['git add -A && git commit -m x', ['add', 'commit']], // both, in order
    ['npm run build', []], // no git call
    ['gitleaks detect', []], // not git — exact basename match only
  ]
  for (const [command, want] of cases) {
    it(`extracts ${JSON.stringify(want)} from ${JSON.stringify(command)}`, () => {
      const got = resolveBashDestinations(command, CWD).segments.flatMap((s) => s.gitSubcommands)
      expect(got).toEqual(want)
    })
  }

  it('git -C is judged as its own segment carrying the destination', () => {
    const dest = resolveBashDestinations('git -C /repo commit -m x', CWD)
    const carrier = dest.segments.find((s) => s.dir === '/repo')
    expect(carrier).toBeDefined()
    expect(carrier!.gitSubcommands).toEqual(['commit'])
  })

  it('git -C does not change the ambient segment directory', () => {
    const dest = resolveBashDestinations('git -C /repo commit -m x && git status', CWD)
    const last = dest.segments[dest.segments.length - 1]
    expect(last.dir).toBe('')
    expect(last.gitSubcommands).toEqual(['status'])
  })

  it('--work-tree=/x carries the value inline', () => {
    const dest = resolveBashDestinations('git --work-tree=/elsewhere commit -m x', CWD)
    expect(dest.segments.find((s) => s.dir === '/elsewhere')?.gitSubcommands).toEqual(['commit'])
  })

  it('captures operation arguments excluding globals and subcommand', () => {
    const dest = resolveBashDestinations('git checkout --detach HEAD', CWD)
    expect(dest.segments[0].gitOperations).toEqual([
      { subcommand: 'checkout', arguments: ['--detach', 'HEAD'] },
    ])
  })
})

describe('dynamic destinations pass with a hint', () => {
  const dynamic = [
    'cd "$TARGET" && git commit -m x',
    'cd $(git rev-parse --show-toplevel) && git commit -m x',
    'cd ~/somewhere && git commit -m x',
    'cd build-*/out && git commit -m x',
  ]
  for (const command of dynamic) {
    it(`surfaces a hint for ${JSON.stringify(command)}`, () => {
      const dest = resolveBashDestinations(command, CWD)
      expect(dest.unresolvedHint).toBeTruthy()
      // The dynamic destination did NOT resolve to a directory.
      expect(dest.segments[0].dir).toBe('')
    })
  }

  it('a dynamic git -C value surfaces a hint', () => {
    const dest = resolveBashDestinations('git -C "$REPO" commit -m x', CWD)
    expect(dest.unresolvedHint).toBeTruthy()
  })
})

describe('merge driver detection and exact grammar', () => {
  it('classifies merge --continue as an exact continue driver', () => {
    const dest = resolveBashDestinations('git merge --continue', CWD)
    expect(dest.segments[0].mergeDriver).toBe('continue')
    expect(dest.segments[0].mergeDriverExact).toBe(true)
  })

  const valid = [
    'git merge --abort',
    '/usr/bin/git merge --continue',
    'git -C /cwd merge --continue',
    'git --no-pager -c user.name=test merge --abort',
    'git --git-dir=/tmp/repo.git merge --continue',
  ]
  for (const command of valid) {
    it(`accepts exact driver ${JSON.stringify(command)}`, () => {
      const dest = resolveBashDestinations(command, CWD)
      expect(dest.segments.length).toBeGreaterThan(0)
      expect(dest.segments[0].mergeDriver).not.toBe('')
      expect(dest.segments[0].mergeDriverExact).toBe(true)
    })
  }

  const unsafe = [
    'git merge --continue && echo hidden',
    'git merge --continue &',
    'git merge --continue >out',
    'git merge --continue <in',
    'git merge --continue | cat',
    'git merge --continue; true',
    '(git merge --continue)',
    '{ git merge --continue; }',
    'env git merge --continue',
    'sudo git merge --continue',
    'git merge --continue extra',
    'git merge --continue --quiet',
    'git merge --continue $(echo hidden)',
    'git merge --continue `echo hidden`',
    "sh -c 'git merge --continue'",
    'git merge "--continue"',
    'git merge --continue\n',
  ]
  for (const command of unsafe) {
    it(`detects but rejects exactness for ${JSON.stringify(command)}`, () => {
      const dest = resolveBashDestinations(command, CWD)
      // The attempt must remain detectable — quoting cannot hide it.
      expect(dest.segments.some((s) => s.mergeDriver !== '')).toBe(true)
      // …but it must not match the exact grammar.
      expect(dest.segments.some((s) => s.mergeDriverExact)).toBe(false)
    })
  }

  it('a fresh merge carries no merge driver', () => {
    const dest = resolveBashDestinations('git merge feature', CWD)
    expect(dest.segments[0].mergeDriver).toBe('')
  })

  it('--quit is detected as a driver attempt but never classified', () => {
    // --quit terminates the merge state without committing; it gets the
    // generic bench-history refusal rather than a carve-out.
    const dest = resolveBashDestinations('git merge --quit', CWD)
    expect(dest.segments[0].mergeDriver).toBe('')
  })

  it('parseExactMergeDriver rejects an empty command', () => {
    expect(parseExactMergeDriver('')).toEqual({ driver: '', exact: false })
    expect(parseExactMergeDriver('   ')).toEqual({ driver: '', exact: false })
  })

  it('parseExactMergeDriver rejects a dangling value-taking global', () => {
    expect(parseExactMergeDriver('git -C').exact).toBe(false)
    expect(parseExactMergeDriver('git --git-dir= merge --continue').exact).toBe(false)
  })

  it('containsUnsafeMergeDriverShell rejects expansion inside double quotes', () => {
    expect(containsUnsafeMergeDriverShell('git merge "--continue$(x)"')).toBe(true)
    expect(containsUnsafeMergeDriverShell('git merge "--`x`"')).toBe(true)
    expect(containsUnsafeMergeDriverShell('git merge "--\\x"')).toBe(true)
  })

  it('containsUnsafeMergeDriverShell treats single quotes as inert but requires termination', () => {
    expect(containsUnsafeMergeDriverShell("echo 'a$b'")).toBe(false)
    expect(containsUnsafeMergeDriverShell("echo 'unterminated")).toBe(true)
  })
})

describe('worktreeIdentityChange', () => {
  const changing: Array<[string, string[], string]> = [
    ['checkout', ['--detach', 'HEAD'], 'checkout --detach'],
    ['checkout', ['-b', 'other'], 'checkout -b'],
    ['checkout', ['-B', 'other', 'HEAD'], 'checkout -b'],
    ['switch', ['main'], 'switch'],
    ['switch', ['--detach', 'HEAD'], 'switch --detach'],
    ['worktree', ['remove', '/tmp/other'], 'worktree remove'],
    ['worktree', ['move', '/a', '/b'], 'worktree move'],
    ['worktree', ['prune'], 'worktree prune'],
  ]
  for (const [subcommand, args, verb] of changing) {
    it(`flags git ${subcommand} ${args.join(' ')}`, () => {
      const got = worktreeIdentityChange({ subcommand, arguments: args })
      expect(got.changes).toBe(true)
      expect(got.verb).toBe(verb)
    })
  }

  const passing: Array<[string, string[]]> = [
    // Bare checkout is ambiguous between ref and pathspec — never refused.
    ['checkout', ['engine/x.go']],
    ['checkout', ['--theirs', 'engine/x.go']],
    // switch --continue/--abort unwind an in-progress switch.
    ['switch', ['--continue']],
    ['switch', ['--abort']],
    ['switch', []],
    // worktree add/list are sanctioned (/align PR mode cuts a worktree).
    ['worktree', ['add', '../x', 'feat/branch']],
    ['worktree', ['list']],
    // History verbs the operator's own workflows use.
    ['rebase', ['--continue']],
    ['reset', ['--soft', 'main']],
    ['commit', ['--amend']],
    ['push', ['-u', 'origin', 'HEAD']],
    ['branch', ['-f', 'backup', 'HEAD']],
  ]
  for (const [subcommand, args] of passing) {
    it(`passes git ${subcommand} ${args.join(' ')}`, () => {
      expect(worktreeIdentityChange({ subcommand, arguments: args }).changes).toBe(false)
    })
  }
})
