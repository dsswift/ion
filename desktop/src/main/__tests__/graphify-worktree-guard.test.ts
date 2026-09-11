/** Graphify primary-checkout ownership guard. */
import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, delimiter } from 'path'
import { normalizeSlashes } from '../../shared/paths'
import { realpathSyncPortable as realpathSync } from '../fs-realpath'

const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..')
const GUARD = join(PROJECT_ROOT, 'scripts', 'graphify-worktree-guard.sh')

let root: string
let repo: string
let worktree: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

// The guard is real POSIX shell tooling invoked via git-bash on Windows CI.
// Its underlying git plumbing (`git rev-parse --show-toplevel`, `git worktree
// list --porcelain`) always reports forward-slash paths, even on Windows --
// exactly like `git worktree list --porcelain` did in the bench/worktree
// path-normalization fix (parseWorktreeList in worktree/integrate.ts). The
// `repo`/`worktree` fixture paths below are built with Node's `path.join`,
// which resolves to native (backslash) separators on win32. Normalize the
// guard's stdout before comparing so both sides describe the same path
// regardless of which side used which separator convention -- the shell
// script itself stays untouched, matching the "normalize the comparison,
// don't force POSIX tooling to emit backslashes" guidance.
function runGuard(cwd: string): string {
  return normalizeSlashes(execFileSync('bash', [GUARD], { cwd, encoding: 'utf-8' }).trim())
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-graph-guard-'))
  repo = join(root, 'repo')
  worktree = join(root, 'worktree')
  git(root, ['init', '-q', repo])
  repo = realpathSync(repo)
  worktree = join(realpathSync(root), 'worktree')
  git(repo, ['config', 'user.email', 'dev@example.com'])
  git(repo, ['config', 'user.name', 'Dev'])
  mkdirSync(join(repo, 'engine'), { recursive: true })
  writeFileSync(join(repo, 'engine', 'go.mod'), 'module fixture\n')
  writeFileSync(join(repo, 'README.md'), 'fixture')
  // Commit engine/go.mod too, not just README: it must exist in the worktree
  // checkout as well as repo, matching a real Ion clone -- the root Makefile's
  // GO_VERSION variable reads it unconditionally on every invocation
  // (`awk ... engine/go.mod`), and an untracked go.mod that exists only in
  // repo pollutes every make-driven assertion's captured output with an
  // unrelated "awk: fatal: cannot open file" line when make runs from worktree.
  git(repo, ['add', 'README.md', 'engine/go.mod'])
  git(repo, ['commit', '-qm', 'init'])
  git(repo, ['worktree', 'add', '-qb', 'wt/graph-guard', worktree])
})

afterEach(() => {
  removeGitFixture(root)
})

type MakeRunner = (cwd: string, target: string) => { ok: boolean; output: string }

/** Wires the fake `graphify` PATH shim and both checkouts' guard script copy, returning a `make` runner. */
function setupMakeEnv(): MakeRunner {
  const bin = join(root, 'bin')
  const log = join(root, 'graphify.log')
  mkdirSync(bin)
  for (const checkout of [repo, worktree]) {
    mkdirSync(join(checkout, 'scripts'))
    copyFileSync(GUARD, join(checkout, 'scripts', 'graphify-worktree-guard.sh'))
  }
  const fakeGraphify = join(bin, 'graphify')
  writeFileSync(fakeGraphify, `#!/bin/sh
echo "$@" >> "${log}"
`)
  chmodSync(fakeGraphify, 0o755)
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` }
  return (cwd: string, target: string) => {
    try {
      return { ok: true, output: execFileSync('make', ['-f', join(PROJECT_ROOT, 'Makefile'), target], { cwd, env, encoding: 'utf-8' }) }
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string }
      return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  }
}

describe('graphify-worktree-guard', () => {
  // Windows CI runs the full suite under the race detector with hundreds of
  // tests spawning git/node/powershell subprocesses concurrently
  // (AGENTS.md § "Windows VM testing" documents the class). This test's two
  // `git`/`bash` subprocess launches can starve under that contention past
  // the suite's default 15s budget even though neither call hangs; a longer
  // per-test budget absorbs the pile-up without masking a real hang.
  it('identifies primary checkout and linked worktree with primary path', { timeout: 30_000 }, () => {
    expect(runGuard(repo)).toBe(`primary ${normalizeSlashes(repo)}`)
    expect(runGuard(worktree)).toBe(`worktree ${normalizeSlashes(repo)}`)
  })

  it('keeps primary ownership when primary HEAD is detached', () => {
    git(repo, ['checkout', '--detach'])

    expect(runGuard(repo)).toBe(`primary ${normalizeSlashes(repo)}`)
    expect(runGuard(worktree)).toBe(`worktree ${normalizeSlashes(repo)}`)
  })

  it('allows primary mutation but refuses every graph mutation target in a worktree', () => {
    // Detached primary HEAD emits no `branch` record in worktree porcelain.
    git(repo, ['checkout', '--detach'])
    const log = join(root, 'graphify.log')
    const make = setupMakeEnv()
    mkdirSync(join(repo, 'graphify-out'))
    writeFileSync(join(repo, 'graphify-out', 'graph.json'), '{}')

    expect(make(repo, 'graph-refresh').ok).toBe(true)
    expect(readFileSync(log, 'utf-8')).toContain(' .')
    const refresh = make(worktree, 'graph-refresh')
    expect(refresh.ok).toBe(true)
    expect(refresh.output).toContain('linked primary graph')
    // git-bash's coreutils ln needs either an elevated process or Developer
    // Mode to create a real NTFS symlink; lacking that (the observed case on
    // Windows CI), `ln -s` silently succeeds but leaves a plain copy instead
    // of a symlink. graph-refresh's idempotency check falls back to a
    // provenance marker (graphify-out/.graph-link-source) for exactly that
    // case, so "already present" still holds on the second call regardless of
    // whether this platform's ln produced a real symlink.
    const second = make(worktree, 'graph-refresh')
    expect(second.ok).toBe(true)
    expect(second.output).toContain('link already present')
    const rebuild = make(worktree, 'graph')
    expect(rebuild.ok).toBe(false)
    expect(rebuild.output).toContain(`primary checkout ${normalizeSlashes(repo)}`)
    expect(make(worktree, 'graph-ensure').ok).toBe(true)
  })

  it('recognizes a provenance-marked copy as already linked when ln -s cannot make a real symlink', () => {
    // Regression test for the Windows CI failure this recipe hit: git-bash's
    // ln -s there silently produces a plain copy instead of a real NTFS
    // symlink, so a check that only trusts `-L` + readlink sees an unrelated
    // file on the second call and refuses. This test pins the fallback
    // directly rather than depending on the host OS's own ln -s behavior --
    // on a POSIX dev machine ln -s genuinely does create a symlink, so the
    // only way to exercise the fallback branch here is to construct its
    // input by hand: a plain-file copy plus the marker graph-refresh writes
    // to record where it came from.
    git(repo, ['checkout', '--detach'])
    const make = setupMakeEnv()
    mkdirSync(join(repo, 'graphify-out'))
    const primary = join(repo, 'graphify-out', 'graph.json')
    writeFileSync(primary, '{}')
    mkdirSync(join(worktree, 'graphify-out'))
    copyFileSync(primary, join(worktree, 'graphify-out', 'graph.json'))
    writeFileSync(join(worktree, 'graphify-out', '.graph-link-source'), normalizeSlashes(primary))

    const result = make(worktree, 'graph-refresh')
    expect(result.ok).toBe(true)
    expect(result.output).toContain('link already present')
  })
})
