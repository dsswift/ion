/** Graphify primary-checkout ownership guard. */
import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'fs'
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
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-qm', 'init'])
  git(repo, ['worktree', 'add', '-qb', 'wt/graph-guard', worktree])
})

afterEach(() => {
  removeGitFixture(root)
})

describe('graphify-worktree-guard', () => {
  it('identifies primary checkout and linked worktree with primary path', () => {
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
    const bin = join(root, 'bin')
    const log = join(root, 'graphify.log')
    mkdirSync(bin)
    for (const checkout of [repo, worktree]) {
      mkdirSync(join(checkout, 'scripts'))
      copyFileSync(GUARD, join(checkout, 'scripts', 'graphify-worktree-guard.sh'))
    }
    mkdirSync(join(repo, 'graphify-out'))
    writeFileSync(join(repo, 'graphify-out', 'graph.json'), '{}')
    const fakeGraphify = join(bin, 'graphify')
    writeFileSync(fakeGraphify, `#!/bin/sh
echo "$@" >> "${log}"
`)
    chmodSync(fakeGraphify, 0o755)
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` }
    const make = (cwd: string, target: string): { ok: boolean; output: string } => {
      try {
        return { ok: true, output: execFileSync('make', ['-f', join(PROJECT_ROOT, 'Makefile'), target], { cwd, env, encoding: 'utf-8' }) }
      } catch (err: unknown) {
        const e = err as { stdout?: Buffer | string; stderr?: Buffer | string }
        return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
      }
    }

    expect(make(repo, 'graph-refresh').ok).toBe(true)
    expect(readFileSync(log, 'utf-8')).toContain(' .')
    const refresh = make(worktree, 'graph-refresh')
    expect(refresh.ok).toBe(true)
    expect(refresh.output).toContain('linked primary graph')
    const second = make(worktree, 'graph-refresh')
    if (!second.output.includes('link already present')) {
      // Diagnostic dump: this has been unexpectedly failing on real Windows
      // CI (never reproduced locally), and the failure output alone doesn't
      // say whether ln -s created a real symlink there at all -- git-bash's
      // coreutils ln needs either an elevated process or Developer Mode to
      // create a real NTFS symlink; without it, `ln -s` can silently produce
      // something readlink/`-L` do not recognize as a symlink, which would
      // explain the "not the primary graph link" refusal on the second call.
      const local = join(worktree, 'graphify-out', 'graph.json')
      let lstatInfo = 'lstat failed'
      try {
        const st = lstatSync(local)
        lstatInfo = `isSymbolicLink=${st.isSymbolicLink()} isFile=${st.isFile()} size=${st.size}`
      } catch (err) {
        lstatInfo = `lstat threw: ${String(err)}`
      }
      let linkTarget = 'readlink failed'
      try {
        linkTarget = readlinkSync(local)
      } catch (err) {
        linkTarget = `readlink threw: ${String(err)}`
      }
      throw new Error(
        `expected 'link already present' in second graph-refresh output\n  output=${second.output}\n  local=${local}\n  lstat=${lstatInfo}\n  readlink=${linkTarget}`,
      )
    }
    const rebuild = make(worktree, 'graph')
    expect(rebuild.ok).toBe(false)
    expect(rebuild.output).toContain(`primary checkout ${normalizeSlashes(repo)}`)
    expect(make(worktree, 'graph-ensure').ok).toBe(true)
  })
})
