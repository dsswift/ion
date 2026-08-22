/**
 * Workspace-record schema pins.
 *
 * Two records, two different consumers:
 *
 * 1. `~/.ion/worktree-registry.json` (main/worktree/inventory.ts) is read by
 *    the ENGINE's workspace containment (engine/internal/workspaces). Both
 *    sides fail open on mismatch, so a field rename here would silently
 *    disable the engine's guard — no error, no failing test, just an empty
 *    view and a passed write. The shared fixture
 *    (engine/internal/workspaces/testdata/worktree-registry.fixture.json) is
 *    the single source of truth: the engine asserts it through its real read
 *    path (registry_fixture_test.go) and this test asserts the live writer
 *    still produces every key it declares. A rename on either side fails
 *    exactly one of the two suites and names the drift.
 *
 * 2. `~/.ion/integration-workspaces.json` (main/integration/bench-store.ts)
 *    is DESKTOP-INTERNAL: the engine no longer reads it (the bench agent
 *    surface moved to the desktop's client tool gate — bench-tool-policy.ts
 *    reads this record through loadWorkspaces). The schema question is now
 *    "do this process's writer and reader agree", so the expected key set is
 *    pinned locally below and asserted against both the written JSON and the
 *    real reader's round-trip. Both still matter: the reader normalizes
 *    defensively, so a renamed key would not throw — it would silently reset
 *    pins, assembly outcomes, or member enablement to defaults.
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
import { saveWorkspaces, loadWorkspaces, makeWorkspace, makeMember, workspacesFile } from '../integration/bench-store'

const FIXTURE_DIR = join(__dirname, '../../../../engine/internal/workspaces/testdata')

/**
 * Every key the integration-workspaces record must carry for the desktop's
 * own readers (bench-tool-policy.ts, bench-ops.ts, the git panel) to answer
 * correctly. Formerly declared by an engine-side fixture; now that the record
 * is desktop-internal, this local pin is the schema's source of truth.
 */
const INTEGRATION_RECORD_KEYS = [
  'workspaces.repoPath',
  'workspaces.sourceBranch',
  'workspaces.benchPath',
  'workspaces.benchBranch',
  'workspaces.baseSha',
  'workspaces.lastBuiltAt',
  'workspaces.lastAssembly',
  'workspaces.members.worktreePath',
  'workspaces.members.branchName',
  'workspaces.members.pin',
  'workspaces.members.merge',
  'workspaces.members.pinnedSha',
  'workspaces.members.pinnedTreeHash',
  'workspaces.members.pinnedBaseSha',
  'workspaces.members.currentTreeHash',
]

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

describe('integration workspaces writer and reader agree on the record schema', () => {
  function saveOneWorkspace(): void {
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
  }

  it('the live writer produces every pinned key', () => {
    saveOneWorkspace()

    const written = JSON.parse(readFileSync(workspacesFile(), 'utf-8')) as unknown
    const writtenKeys = keyPaths(written)
    const missing = INTEGRATION_RECORD_KEYS.filter((k) => !writtenKeys.has(k))
    expect(missing, `desktop writer no longer produces pinned record keys: ${missing.join(', ')}`).toEqual([])
  })

  it('the live reader decodes every pinned field to its written value', () => {
    saveOneWorkspace()

    // The REAL read path, including normalization — a renamed key would not
    // throw here, it would silently collapse the field to its default, which
    // is exactly the drift this assertion set exists to catch.
    const loaded = loadWorkspaces()
    expect(loaded).toHaveLength(1)
    const w = loaded[0]
    expect(w.repoPath).toBe('/repo/project')
    expect(w.sourceBranch).toBe('main')
    expect(w.benchPath).toBeTruthy()
    expect(w.benchBranch).toBeTruthy()
    expect(w.baseSha).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(w.lastBuiltAt).toBe(1700000200000)
    expect(w.lastAssembly).toBe('assembled')

    expect(w.members).toHaveLength(1)
    const m = w.members[0]
    expect(m.worktreePath).toBe('/wt/project-aaa')
    expect(m.branchName).toBe('wt/project-aaa')
    expect(m.pin).toBe('current')
    expect(m.merge).toBe('unbuilt')
    expect(m.pinnedSha).toBe('89abcdef0123456789abcdef0123456789abcdef')
    expect(m.pinnedTreeHash).toBe('fedcba9876543210fedcba9876543210fedcba98')
    expect(m.pinnedBaseSha).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(m.currentTreeHash).toBe('fedcba9876543210fedcba9876543210fedcba98')
  })
})
