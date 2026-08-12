/**
 * Seeding: the ladder, and the guard that keeps `git status` clean.
 *
 * ── The regression pin ──────────────────────────────────────────────────────
 * The defect this feature exists to prevent was observed in the field: an
 * improvised `node_modules` in a worktree showed up as `?? node_modules`, and
 * the agent had to remember to delete it before committing. So the load-bearing
 * assertion here is that a declared path git does NOT ignore is refused, and the
 * worktree's `git status --porcelain` stays empty.
 *
 * ── Why real git and a real filesystem ──────────────────────────────────────
 * The whole mechanism is filesystem and git behaviour: reflink support,
 * check-ignore semantics, symlink handling. Mocking those would assert that the
 * mocks agree with each other, not that the seeder works.
 */
import { removeGitFixture } from '../../../test/git-fixture-cleanup'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, lstatSync, readFileSync, readlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { seedEntry, reconcileStale } from '../provision-seed'
import { _resetCapabilityCacheForTests } from '../provision-capability'

let root: string
let repo: string
let worktree: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

beforeEach(() => {
  _resetCapabilityCacheForTests()
  root = mkdtempSync(join(tmpdir(), 'ion-seed-'))
  repo = join(root, 'repo')
  worktree = join(root, 'wt')
  mkdirSync(repo, { recursive: true })
  mkdirSync(worktree, { recursive: true })

  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'dev@example.com'])
  git(repo, ['config', 'user.name', 'Dev'])
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\nbuild-cache/\ngraphify-out/\n')
  writeFileSync(join(repo, 'package-lock.json'), '{"v":1}')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'init'])

  // The worktree is a plain directory here: the seeder only needs the source
  // repo for check-ignore, and a real `git worktree add` would couple these
  // tests to worktree plumbing they do not exercise.
  writeFileSync(join(worktree, 'package-lock.json'), '{"v":1}')
})

afterEach(() => {
  removeGitFixture(root)
})

describe('the check-ignore guard — the regression pin', () => {
  it('refuses to seed a path git does not ignore, leaving git status clean', async () => {
    // `src` is tracked, not ignored. Seeding it would produce exactly the
    // `?? src` pollution this guard exists to prevent.
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'src'])

    const result = await seedEntry(repo, worktree, { path: 'src' })

    expect(result.strategy).toBe('skipped')
    expect(result.reason).toContain('not gitignored')
    expect(existsSync(join(worktree, 'src'))).toBe(false)
    // The source repo must be untouched by a refusal.
    expect(git(repo, ['status', '--porcelain']).trim()).toBe('')
  })

  it('refuses an untracked-but-not-ignored path', async () => {
    mkdirSync(join(repo, 'scratch'), { recursive: true })
    writeFileSync(join(repo, 'scratch', 'x'), 'x')

    const result = await seedEntry(repo, worktree, { path: 'scratch' })

    expect(result.strategy).toBe('skipped')
    expect(existsSync(join(worktree, 'scratch'))).toBe(false)
  })

  it('seeds a path git DOES ignore', async () => {
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1')

    const result = await seedEntry(repo, worktree, { path: 'node_modules' })

    expect(['clone', 'copy']).toContain(result.strategy)
    expect(existsSync(join(worktree, 'node_modules', 'pkg', 'index.js'))).toBe(true)
  })
})


describe('linked file seeds', () => {
  it('links a primary-owned graph file while keeping query state local', async () => {
    const source = join(repo, 'graphify-out', 'graph.json')
    mkdirSync(join(repo, 'graphify-out'), { recursive: true })
    writeFileSync(source, '{"nodes":[]}')

    const result = await seedEntry(repo, worktree, { path: 'graphify-out/graph.json', link: true })

    const dest = join(worktree, 'graphify-out', 'graph.json')
    expect(result.strategy).toBe('link')
    expect(lstatSync(dest).isSymbolicLink()).toBe(true)
    expect(readlinkSync(dest)).toBe(source)
    mkdirSync(join(worktree, 'graphify-out', 'cache'), { recursive: true })
    writeFileSync(join(worktree, 'graphify-out', 'cache', 'last_query_stamp'), 'now')
    expect(existsSync(join(repo, 'graphify-out', 'cache', 'last_query_stamp'))).toBe(false)
    expect(git(repo, ['status', '--porcelain']).trim()).toBe('')
    rmSync(worktree, { recursive: true, force: true })
    expect(readFileSync(source, 'utf-8')).toBe('{"nodes":[]}')
  })

  it('skips a missing optional linked source file', async () => {
    const result = await seedEntry(repo, worktree, { path: 'graphify-out/graph.json', link: true })
    expect(result.strategy).toBe('skipped')
    expect(result.reason).toContain('absent')
  })

  it('is idempotent only for the expected primary link', async () => {
    const source = join(repo, 'graphify-out', 'graph.json')
    mkdirSync(join(repo, 'graphify-out'), { recursive: true })
    writeFileSync(source, '{}')
    await seedEntry(repo, worktree, { path: 'graphify-out/graph.json', link: true })

    const result = await seedEntry(repo, worktree, { path: 'graphify-out/graph.json', link: true })
    expect(result.strategy).toBe('skipped')
    expect(result.reason).toContain('already linked')
  })

  it('does not replace a real destination', async () => {
    const source = join(repo, 'graphify-out', 'graph.json')
    const dest = join(worktree, 'graphify-out', 'graph.json')
    mkdirSync(join(repo, 'graphify-out'), { recursive: true })
    mkdirSync(join(worktree, 'graphify-out'), { recursive: true })
    writeFileSync(source, '{}')
    writeFileSync(dest, 'local graph')

    const result = await seedEntry(repo, worktree, { path: 'graphify-out/graph.json', link: true })
    expect(result.strategy).toBe('failed')
    expect(readFileSync(dest, 'utf-8')).toBe('local graph')
  })

  it('does not replace a link to a different source', async () => {
    const source = join(repo, 'graphify-out', 'graph.json')
    const wrongSource = join(repo, 'graphify-out', 'other.json')
    const dest = join(worktree, 'graphify-out', 'graph.json')
    mkdirSync(join(repo, 'graphify-out'), { recursive: true })
    mkdirSync(join(worktree, 'graphify-out'), { recursive: true })
    writeFileSync(source, '{}')
    writeFileSync(wrongSource, 'other')
    const { symlinkSync } = await import('fs')
    symlinkSync(wrongSource, dest)

    const result = await seedEntry(repo, worktree, { path: 'graphify-out/graph.json', link: true })
    expect(result.strategy).toBe('failed')
    expect(readlinkSync(dest)).toBe(wrongSource)
  })
})

describe('the ladder', () => {
  it('prefers build over copy when reflink is unavailable', async () => {
    // Force the no-reflink path by pointing the seeder at a source that does not
    // exist: clone needs a source, so the ladder falls through to build.
    const marker = join(worktree, 'built.txt')
    const result = await seedEntry(repo, worktree, {
      path: 'build-cache',
      build: `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}', 'yes')"`,
    })

    expect(result.strategy).toBe('build')
    expect(readFileSync(marker, 'utf-8')).toBe('yes')
  })

  it('falls back to copy only when no build command is declared', async () => {
    mkdirSync(join(repo, 'build-cache'), { recursive: true })
    writeFileSync(join(repo, 'build-cache', 'artifact'), 'data')

    const result = await seedEntry(repo, worktree, { path: 'build-cache' })

    // On APFS this is a clone; elsewhere a copy. Either way it is NOT a build,
    // because none was declared — and the content must arrive.
    expect(['clone', 'copy']).toContain(result.strategy)
    expect(readFileSync(join(worktree, 'build-cache', 'artifact'), 'utf-8')).toBe('data')
  })

  it('reports failed when the build command fails', async () => {
    const result = await seedEntry(repo, worktree, {
      path: 'build-cache',
      build: 'exit 3',
    })

    expect(result.strategy).toBe('failed')
    expect(result.reason).toContain('build command failed')
  })

  it('skips when there is nothing to copy and no build command', async () => {
    const result = await seedEntry(repo, worktree, { path: 'build-cache' })
    expect(result.strategy).toBe('skipped')
    expect(result.reason).toContain('nothing to copy')
  })

  it('skips a path already present in the worktree', async () => {
    mkdirSync(join(repo, 'node_modules'), { recursive: true })
    mkdirSync(join(worktree, 'node_modules'), { recursive: true })

    const result = await seedEntry(repo, worktree, { path: 'node_modules' })

    expect(result.strategy).toBe('skipped')
    expect(result.reason).toContain('already present')
  })
})

describe('seeding preserves what downstream tools key on', () => {
  it('preserves mtimes so an incremental refresh stays incremental', async () => {
    // graphify's manifest keys on mtime alongside content hashes. A seed that
    // rewrote mtimes would make the next `graphify update .` re-extract the whole
    // tree, turning a cheap refresh into a full rebuild.
    mkdirSync(join(repo, 'build-cache'), { recursive: true })
    const src = join(repo, 'build-cache', 'graph.json')
    writeFileSync(src, '{"nodes":[]}')
    const { statSync, utimesSync } = await import('fs')
    const past = new Date(Date.now() - 86_400_000)
    utimesSync(src, past, past)
    const sourceMtime = statSync(src).mtimeMs

    await seedEntry(repo, worktree, { path: 'build-cache' })

    const seededMtime = statSync(join(worktree, 'build-cache', 'graph.json')).mtimeMs
    expect(Math.abs(seededMtime - sourceMtime)).toBeLessThan(2000)
  })
})

describe('staleness reconciliation', () => {
  it('does not rebuild when the staleWhen files match', async () => {
    const marker = join(worktree, 'rebuilt.txt')
    const ran = await reconcileStale(repo, worktree, {
      path: 'node_modules',
      build: `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}', 'yes')"`,
      staleWhen: ['package-lock.json'],
    })

    expect(ran).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })

  it('rebuilds when the worktree lockfile diverges from the source', async () => {
    writeFileSync(join(worktree, 'package-lock.json'), '{"v":2}')
    const marker = join(worktree, 'rebuilt.txt')

    const ran = await reconcileStale(repo, worktree, {
      path: 'node_modules',
      build: `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}', 'yes')"`,
      staleWhen: ['package-lock.json'],
    })

    expect(ran).toBe(true)
    expect(readFileSync(marker, 'utf-8')).toBe('yes')
  })

  it('treats a missing lockfile as stale', async () => {
    rmSync(join(worktree, 'package-lock.json'))
    const marker = join(worktree, 'rebuilt.txt')

    const ran = await reconcileStale(repo, worktree, {
      path: 'node_modules',
      build: `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}', 'yes')"`,
      staleWhen: ['package-lock.json'],
    })

    expect(ran).toBe(true)
  })

  it('is a no-op with no build command or no staleWhen', async () => {
    expect(await reconcileStale(repo, worktree, { path: 'x', staleWhen: ['package-lock.json'] })).toBe(false)
    expect(await reconcileStale(repo, worktree, { path: 'x', build: 'true' })).toBe(false)
  })
})
