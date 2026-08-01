/**
 * Workspace-record schema parity — the desktop half of the shared-fixture pin.
 *
 * The engine's workspace containment (engine/internal/workspaces) reads the
 * two records THIS process writes: ~/.ion/worktree-registry.json
 * (main/worktree/inventory.ts) and ~/.ion/integration-workspaces.json
 * (main/integration/bench-store.ts). Both sides fail open on mismatch, so a
 * field rename here would silently disable the engine's guard — no error, no
 * failing test, just an empty view and a passed write.
 *
 * These tests close that gap: they drive the REAL writers, then assert the
 * written JSON still carries every key the engine's shared fixtures
 * (engine/internal/workspaces/testdata/*.fixture.json) declare the engine
 * consumes. The engine asserts the same fixtures through its real read path
 * (registry_fixture_test.go), so the fixture is the single source of truth —
 * a rename on either side fails exactly one of the two suites and names the
 * drift.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// Redirect HOME so the real writers persist into a temp dir, never ~/.ion.
// Per-file env var: vitest runs test files concurrently in one process.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_RECORD_PARITY || actual.homedir() }
})

import { registerWorktree, worktreeRegistryFile } from '../worktree/inventory'
import { saveWorkspaces, makeWorkspace, makeMember, workspacesFile } from '../integration/bench-store'

const FIXTURE_DIR = join(__dirname, '../../../../engine/internal/workspaces/testdata')

/** Every key path present in `fixture`, as dot paths ("entries.worktreePath"). */
function keyPaths(node: unknown, prefix = ''): Set<string> {
  const out = new Set<string>()
  if (Array.isArray(node)) {
    // Arrays merge their elements' keys: the schema question is "what fields
    // can an element carry", not per-index shape.
    for (const el of node) for (const k of keyPaths(el, prefix)) out.add(k)
    return out
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === '__comment') continue
      const path = prefix ? `${prefix}.${k}` : k
      out.add(path)
      for (const nested of keyPaths(v, path)) out.add(nested)
    }
  }
  return out
}

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ion-record-parity-'))
  process.env.ION_TEST_HOME_RECORD_PARITY = home
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_RECORD_PARITY
  rmSync(home, { recursive: true, force: true })
})

describe('worktree registry writer matches the engine fixture schema', () => {
  it('the live writer produces every key the engine consumes', () => {
    // Drive the REAL writer with a record shaped like the fixture's entries.
    registerWorktree({
      worktreePath: '/wt/project-aaa',
      repoPath: '/repo/project',
      branchName: 'wt/project-aaa',
      sourceBranch: 'main',
      title: 'fixture parity probe',
    })

    const written = JSON.parse(readFileSync(worktreeRegistryFile(), 'utf-8')) as unknown
    const fixture = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'worktree-registry.fixture.json'), 'utf-8'),
    ) as unknown

    const writtenKeys = keyPaths(written)
    // Optional keys the writer only emits situationally (landedAt is set by
    // the land verb, not registration) are asserted as KNOWN to the writer's
    // type instead of demanded from this particular write.
    const situational = new Set(['entries.landedAt', 'entries.title'])
    const missing = [...keyPaths(fixture)].filter(
      (k) => !writtenKeys.has(k) && !situational.has(k),
    )
    expect(missing, `desktop writer no longer produces keys the engine reads: ${missing.join(', ')}`).toEqual([])
  })
})

describe('integration workspaces writer matches the engine fixture schema', () => {
  it('the live writer produces every key the engine consumes', () => {
    const ws = makeWorkspace('/repo/project', 'main')
    const member = makeMember({
      worktreePath: '/wt/project-aaa',
      branchName: 'wt/project-aaa',
      pinnedSha: '89abcdef0123456789abcdef0123456789abcdef',
      pinnedTreeHash: 'fedcba9876543210fedcba9876543210fedcba98',
      pinnedBaseSha: '0123456789abcdef0123456789abcdef01234567',
    })
    saveWorkspaces([{
      ...ws,
      baseSha: '0123456789abcdef0123456789abcdef01234567',
      lastBuiltAt: 1700000200000,
      lastAssembly: 'assembled',
      members: [member],
    }])

    const written = JSON.parse(readFileSync(workspacesFile(), 'utf-8')) as unknown
    const fixture = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'integration-workspaces.fixture.json'), 'utf-8'),
    ) as unknown

    const writtenKeys = keyPaths(written)
    const missing = [...keyPaths(fixture)].filter((k) => !writtenKeys.has(k))
    expect(missing, `desktop writer no longer produces keys the engine reads: ${missing.join(', ')}`).toEqual([])
  })
})
