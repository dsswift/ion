/**
 * Provisioning orchestration.
 *
 * The properties that matter are sequencing and failure containment: seed
 * before setup, one bad entry must not deprive the worktree of the others, and
 * a failure must land in `failed` with a reason rather than throwing into a
 * fire-and-forget caller.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { provisionWorktree, _resetProvisionQueuesForTests } from '../provision'
import { _resetCapabilityCacheForTests } from '../provision-capability'
import type { WorktreeProvisionState } from '../../../shared/types'

let root: string
let repo: string
let worktree: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

/** A shell command that appends a marker line, so ordering is observable. */
function appendMarker(file: string, text: string): string {
  const f = file.replace(/\\/g, '\\\\')
  return `node -e "require('fs').appendFileSync('${f}', '${text}\\n')"`
}

function writeManifest(obj: unknown): void {
  mkdirSync(join(repo, '.ion'), { recursive: true })
  writeFileSync(join(repo, '.ion', 'worktree.json'), JSON.stringify(obj))
}

beforeEach(() => {
  _resetProvisionQueuesForTests()
  _resetCapabilityCacheForTests()
  root = mkdtempSync(join(tmpdir(), 'ion-prov-'))
  repo = join(root, 'repo')
  worktree = join(root, 'wt')
  mkdirSync(repo, { recursive: true })
  mkdirSync(worktree, { recursive: true })

  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'dev@example.com'])
  git(repo, ['config', 'user.name', 'Dev'])
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\ncache/\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'init'])
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('provisionWorktree — the additive guarantee', () => {
  it('is a no-op that reports ready when the repo has no manifest', async () => {
    const outcome = await provisionWorktree(repo, worktree)
    expect(outcome.state).toBe('ready')
    expect(outcome.results).toEqual([])
  })

  it('reports ready for a manifest with an empty seed and no setup', async () => {
    writeManifest({ version: 1, worktree: { seed: [] } })
    const outcome = await provisionWorktree(repo, worktree)
    expect(outcome.state).toBe('ready')
  })
})

describe('provisionWorktree — sequencing', () => {
  it('runs every seed entry before setup', async () => {
    const order = join(worktree, 'order.txt')
    writeManifest({
      version: 1,
      worktree: {
        seed: [
          { path: 'node_modules', build: appendMarker(order, 'seed-a') },
          { path: 'cache', build: appendMarker(order, 'seed-b') },
        ],
        setup: appendMarker(order, 'setup'),
      },
    })

    const outcome = await provisionWorktree(repo, worktree)

    expect(outcome.state).toBe('ready')
    expect(readFileSync(order, 'utf-8').trim().split('\n')).toEqual(['seed-a', 'seed-b', 'setup'])
  })

  it('emits progress states ending in ready', async () => {
    writeManifest({ version: 1, worktree: { seed: [{ path: 'node_modules', build: 'true' }] } })
    const seen: WorktreeProvisionState[] = []

    await provisionWorktree(repo, worktree, (s) => seen.push(s))

    expect(seen[0]).toBe('seeding')
    expect(seen[seen.length - 1]).toBe('ready')
  })
})

describe('provisionWorktree — failure containment', () => {
  it('continues past a failed entry and still runs setup, ending failed', async () => {
    const order = join(worktree, 'order.txt')
    writeManifest({
      version: 1,
      worktree: {
        seed: [
          { path: 'node_modules', build: 'exit 7' },
          { path: 'cache', build: appendMarker(order, 'second-ran') },
        ],
        setup: appendMarker(order, 'setup-ran'),
      },
    })

    const outcome = await provisionWorktree(repo, worktree)

    // The later entry and setup both ran despite the earlier failure …
    expect(readFileSync(order, 'utf-8')).toContain('second-ran')
    expect(readFileSync(order, 'utf-8')).toContain('setup-ran')
    // … and the outcome is honest about the failure.
    expect(outcome.state).toBe('failed')
    expect(outcome.error).toContain('node_modules')
  })

  it('reports failed when only setup fails', async () => {
    writeManifest({ version: 1, worktree: { seed: [], setup: 'exit 4' } })
    const outcome = await provisionWorktree(repo, worktree)
    expect(outcome.state).toBe('failed')
    expect(outcome.error).toContain('setup')
  })

  it('never rejects, so a fire-and-forget caller cannot produce an unhandled rejection', async () => {
    writeManifest({ version: 1, worktree: { seed: [{ path: 'node_modules', build: 'exit 1' }] } })
    await expect(provisionWorktree(repo, worktree)).resolves.toBeTruthy()
  })

  it('a failing run does not poison the queue for the next worktree', async () => {
    writeManifest({ version: 1, worktree: { seed: [{ path: 'node_modules', build: 'exit 1' }] } })
    const first = await provisionWorktree(repo, worktree)
    expect(first.state).toBe('failed')

    const second = join(root, 'wt2')
    mkdirSync(second, { recursive: true })
    writeManifest({ version: 1, worktree: { seed: [{ path: 'node_modules', build: 'true' }] } })
    const outcome = await provisionWorktree(repo, second)
    expect(outcome.state).toBe('ready')
  })
})

describe('provisionWorktree — serialization', () => {
  it('serializes concurrent runs for one repo', async () => {
    // Two runs started together must not interleave: the marker file records
    // enter/exit pairs, and a nested pair would prove overlap.
    const order = join(root, 'serial.txt')
    const f = order.replace(/\\/g, '\\\\')
    const slow = `node -e "const fs=require('fs');fs.appendFileSync('${f}','in\\n');setTimeout(()=>fs.appendFileSync('${f}','out\\n'),60)" && sleep 0.1`
    writeManifest({ version: 1, worktree: { seed: [{ path: 'node_modules', build: slow }] } })

    const second = join(root, 'wt2')
    mkdirSync(second, { recursive: true })

    await Promise.all([
      provisionWorktree(repo, worktree),
      provisionWorktree(repo, second),
    ])

    const lines = readFileSync(order, 'utf-8').trim().split('\n')
    expect(lines).toEqual(['in', 'out', 'in', 'out'])
  })
})

describe('provisionWorktree — the git-status guarantee', () => {
  it('leaves the worktree free of non-ignored artifacts', async () => {
    // A tracked path declared as a seed must be refused, so the repo stays clean.
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src', 'a.ts'), 'x')
    writeManifest({ version: 1, worktree: { seed: [{ path: 'src' }] } })
    // Commit the manifest too: an uncommitted fixture file would show up in
    // `git status` and mask the thing under test.
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'src + manifest'])

    await provisionWorktree(repo, worktree)

    expect(existsSync(join(worktree, 'src'))).toBe(false)
    expect(git(repo, ['status', '--porcelain']).trim()).toBe('')
  })
})
