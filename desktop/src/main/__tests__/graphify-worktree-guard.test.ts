/** Graphify primary-checkout ownership guard. */
import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PROJECT_ROOT = join(__dirname, '..', '..', '..', '..')
const GUARD = join(PROJECT_ROOT, 'scripts', 'graphify-worktree-guard.sh')

let root: string
let repo: string
let worktree: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

function runGuard(cwd: string): string {
  return execFileSync('bash', [GUARD], { cwd, encoding: 'utf-8' }).trim()
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
    expect(runGuard(repo)).toBe(`primary ${repo}`)
    expect(runGuard(worktree)).toBe(`worktree ${repo}`)
  })

  it('keeps primary ownership when primary HEAD is detached', () => {
    git(repo, ['checkout', '--detach'])

    expect(runGuard(repo)).toBe(`primary ${repo}`)
    expect(runGuard(worktree)).toBe(`worktree ${repo}`)
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
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
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
    expect(make(worktree, 'graph-refresh').output).toContain('link already present')
    const rebuild = make(worktree, 'graph')
    expect(rebuild.ok).toBe(false)
    expect(rebuild.output).toContain(`primary checkout ${repo}`)
    expect(make(worktree, 'graph-ensure').ok).toBe(true)
  })
})
