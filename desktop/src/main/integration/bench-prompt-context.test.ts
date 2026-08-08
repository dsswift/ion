/**
 * Bench prompt context behaviour, ported from the bench half of
 * engine/internal/workspaces/prompt_context_test.go.
 *
 * The property under test throughout is that the record is the contract: every
 * fact the prose states is read from the workspace record (and the worktree
 * registry for titles), never guessed from the tree. No git is needed — the
 * module is pure record projection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// Redirect HOME so the workspace records land in a fixture, never the
// developer's ~/.ion. Per-file env var: vitest runs test FILES concurrently in
// one process, so a shared name would let files clobber each other's fake home.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_PROMPT || actual.homedir() }
})

import { benchPromptContext, benchClientWorkspaceContext, BENCH_CONTEXT_MARKER } from './bench-prompt-context'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ion-benchprompt-'))
  mkdirSync(join(home, '.ion'), { recursive: true })
  process.env.ION_TEST_HOME_BENCH_PROMPT = home
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_BENCH_PROMPT
  rmSync(home, { recursive: true, force: true })
})

const repoPath = '/repo/project'
const benchPath = '/bench/project-main'

/** Member record with the full shape the desktop's normalizer expects. */
function member(over: Record<string, unknown>): Record<string, unknown> {
  return {
    enabled: true, pin: 'current', merge: 'merged',
    pinnedSha: '', pinnedBaseSha: '', pinnedTreeHash: '', currentTreeHash: '',
    ...over,
  }
}

function writeRecord(workspace: Record<string, unknown>): void {
  writeFileSync(
    join(home, '.ion', 'integration-workspaces.json'),
    JSON.stringify({
      version: 1,
      workspaces: [{ repoPath, sourceBranch: 'main', benchPath, ...workspace }],
    }),
  )
}

function writeRegistry(entries: Record<string, unknown>[]): void {
  writeFileSync(
    join(home, '.ion', 'worktree-registry.json'),
    JSON.stringify({ version: 1, entries }),
  )
}

describe('containment', () => {
  it('returns empty for a directory outside any bench', () => {
    writeRecord({ lastAssembly: 'assembled' })
    expect(benchPromptContext('/somewhere/unrelated')).toBe('')
  })

  it('returns empty for an empty cwd and when no record exists', () => {
    expect(benchPromptContext('')).toBe('')
    expect(benchPromptContext('/bench/project-main')).toBe('')
  })

  it('resolves a bench subdirectory as the bench', () => {
    writeRecord({ lastAssembly: 'assembled' })
    expect(benchPromptContext(join(benchPath, 'desktop', 'src'))).toContain(BENCH_CONTEXT_MARKER)
  })

  // The sibling-prefix trap: a bare startsWith would attribute
  // /bench/project-main-other to /bench/project-main.
  it('does not match a sibling whose name merely begins with the bench path', () => {
    writeRecord({ lastAssembly: 'assembled' })
    expect(benchPromptContext(benchPath + '-other')).toBe('')
  })

  it('fails open on a corrupt record', () => {
    writeFileSync(join(home, '.ion', 'integration-workspaces.json'), 'not json {{{')
    expect(benchPromptContext(benchPath)).toBe('')
  })
})

describe('bench prose', () => {
  it('renders the marker, identity, and members in merge order with pinned ranges', () => {
    writeRegistry([
      { worktreePath: '/wt/first', repoPath, branchName: 'wt/first', sourceBranch: 'main', title: 'first worktree', createdAt: 1 },
      { worktreePath: '/wt/second', repoPath, branchName: 'wt/second', sourceBranch: 'main', title: 'second worktree', createdAt: 1 },
    ])
    writeRecord({
      benchBranch: 'ion/bench/main', baseSha: 'aaaa1111', lastAssembly: 'assembled',
      members: [
        member({ worktreePath: '/wt/first', branchName: 'wt/first', pinnedSha: '1111', pinnedBaseSha: 'aaaa1111', pinnedTreeHash: 'tree1', currentTreeHash: 'tree1' }),
        member({ worktreePath: '/wt/second', branchName: 'wt/second', pinnedSha: '2222', pinnedBaseSha: 'aaaa1111', pinnedTreeHash: 'tree2', currentTreeHash: 'tree2' }),
      ],
    })

    const prose = benchPromptContext(join(benchPath, 'desktop', 'src'))

    expect(prose).toContain(BENCH_CONTEXT_MARKER)
    for (const want of [benchPath, 'ion/bench/main', 'aaaa1111..1111', '/wt/first', 'destroyed']) {
      expect(prose).toContain(want)
    }
    // Titles must be joined from the worktree registry.
    expect(prose).toContain('first worktree')
    // Merge order must survive into the prose: it is the order the assembly
    // merges in, so it is the order collisions are attributed in.
    expect(prose.indexOf('wt/first')).toBeLessThan(prose.indexOf('wt/second'))
  })

  it('names all three read-only bench tools', () => {
    writeRecord({ lastAssembly: 'assembled' })
    const prose = benchPromptContext(benchPath)
    // All THREE must be named: this prose is the only place a model learns
    // they exist, and naming only attribution left the other two
    // undiscoverable — the conflict then got worked by hand.
    for (const tool of ['WorkspaceAttribution', 'BenchResolutionHistory', 'BenchMemberFile']) {
      expect(prose).toContain(tool)
    }
  })

  it('states a bench with no enabled members explicitly', () => {
    writeRecord({ lastAssembly: 'assembled' })
    expect(benchPromptContext(benchPath)).toContain('No enabled members')
  })

  // Disabled members are reported SEPARATELY. Merging them into the member
  // list would attribute assembled bytes to work the bench never received.
  it('lists disabled members separately with the DISABLED wording', () => {
    writeRecord({
      lastAssembly: 'assembled',
      members: [
        member({ worktreePath: '/wt/on', branchName: 'wt/on', enabled: true, pinnedSha: '1', pinnedBaseSha: '0' }),
        member({ worktreePath: '/wt/off', branchName: 'wt/off', enabled: false, pinnedSha: '2', pinnedBaseSha: '0' }),
      ],
    })

    const prose = benchPromptContext(benchPath)

    expect(prose).toContain('DISABLED')
    expect(prose).toContain('not in this bench')
    // The disabled member must not appear in the numbered enabled list.
    expect(prose).not.toMatch(/^\d+\. wt\/off/m)
    expect(prose).toContain('- wt/off')
  })
})

describe('warnings', () => {
  // A FAILED assembly means the bench was wiped to an empty tree, so anything
  // built or tested there is not the enrolled combination. Silence here would
  // let an agent draw conclusions from nothing.
  it('warns on a failed assembly with the recorded error', () => {
    writeRecord({
      lastAssembly: 'failed', lastAssemblyError: 'wt/beta conflicted in app.txt',
      members: [member({ worktreePath: '/wt/on', branchName: 'wt/on', pinnedSha: '1', pinnedBaseSha: '0' })],
    })

    const prose = benchPromptContext(benchPath)

    expect(prose).toContain('wiped to an empty tree')
    expect(prose).toContain('wt/beta conflicted in app.txt')
  })

  // An ABSENT outcome is unknown — never read as success and never as failure.
  it('warns when the assembly outcome is unknown', () => {
    writeRecord({
      members: [member({ worktreePath: '/wt/on', branchName: 'wt/on', pinnedSha: '1', pinnedBaseSha: '0' })],
    })
    expect(benchPromptContext(benchPath)).toContain('unknown')
  })

  // A STALE pin means the bench holds work the member has already moved past,
  // so a diagnosis made in the bench may already be answered in the member.
  it('warns on a stale pin', () => {
    writeRecord({
      lastAssembly: 'assembled',
      members: [member({
        worktreePath: '/wt/stale', branchName: 'wt/stale',
        pinnedSha: '1', pinnedBaseSha: '0', pinnedTreeHash: 'old', currentTreeHash: 'new',
      })],
    })

    const prose = benchPromptContext(benchPath)

    expect(prose).toContain('behind their worktrees')
    expect(prose).toContain('The bench holds the PINNED work, not the current work in those worktrees.')
    expect(prose).toContain('pin behind worktree')
  })

  // ABSENT tree hashes are UNKNOWN freshness, not freshness. Reading an
  // absent hash as current would assert a fact the record does not carry.
  it('distinguishes unknown staleness from current', () => {
    writeRecord({
      lastAssembly: 'assembled',
      members: [member({ worktreePath: '/wt/nohash', branchName: 'wt/nohash', pinnedSha: '1', pinnedBaseSha: '0' })],
    })

    const prose = benchPromptContext(benchPath)

    expect(prose).toContain('freshness is unknown')
    expect(prose).not.toContain('behind their worktrees')
  })

  it('warns on a conflicted member naming counterparts and paths, and on a replayed resolution', () => {
    writeRecord({
      lastAssembly: 'assembled',
      members: [
        member({
          worktreePath: '/wt/c', branchName: 'wt/c', pinnedSha: '1', pinnedBaseSha: '0',
          merge: 'conflicted', conflictPaths: ['app.txt'], conflictsWith: ['wt/other'],
          pinnedTreeHash: 't', currentTreeHash: 't',
        }),
        member({
          worktreePath: '/wt/r', branchName: 'wt/r', pinnedSha: '2', pinnedBaseSha: '0',
          merge: 'merged', mergeResolution: 'replayed', pinnedTreeHash: 't', currentTreeHash: 't',
        }),
      ],
    })

    const prose = benchPromptContext(benchPath)

    expect(prose).toContain('CONFLICTS')
    expect(prose).toContain('app.txt')
    expect(prose).toContain('wt/other')
    // A replayed resolution is not the same fact as a clean merge.
    expect(prose).toContain('replayed')
  })

  // An EMPTY contribution (equal base and tip) is distinct from having landed,
  // and the record is the only place that fact survives.
  it('warns on an empty contribution', () => {
    writeRecord({
      lastAssembly: 'assembled',
      members: [member({
        worktreePath: '/wt/empty', branchName: 'wt/empty',
        pinnedSha: 'same', pinnedBaseSha: 'same', pinnedTreeHash: 't', currentTreeHash: 't',
      })],
    })

    const prose = benchPromptContext(benchPath)

    expect(prose).toContain('contributes nothing')
    expect(prose).toContain('empty contribution')
  })

  // A disabled member's pins are not merged, so its staleness must not warn.
  it('derives staleness warnings from enabled members only', () => {
    writeRecord({
      lastAssembly: 'assembled',
      members: [member({
        worktreePath: '/wt/off', branchName: 'wt/off', enabled: false,
        pinnedSha: '1', pinnedBaseSha: '0', pinnedTreeHash: 'old', currentTreeHash: 'new',
      })],
    })
    expect(benchPromptContext(benchPath)).not.toContain('behind their worktrees')
  })
})

describe('benchClientWorkspaceContext', () => {
  it('returns null for a directory outside any bench', () => {
    writeRecord({ lastAssembly: 'assembled' })
    expect(benchClientWorkspaceContext('/somewhere/unrelated')).toBeNull()
  })

  it('returns null for empty cwd', () => {
    expect(benchClientWorkspaceContext('')).toBeNull()
  })

  it('returns kind=bench with bench field (not data) populated', () => {
    writeRegistry([
      { worktreePath: '/wt/first', repoPath, branchName: 'wt/first', sourceBranch: 'main', title: 'first', createdAt: 1 },
    ])
    writeRecord({
      benchBranch: 'ion/bench/main', baseSha: 'aaaa1111', lastAssembly: 'assembled',
      members: [
        member({ worktreePath: '/wt/first', branchName: 'wt/first', pinnedSha: '1111', pinnedBaseSha: 'aaaa1111', pinnedTreeHash: 't', currentTreeHash: 't' }),
      ],
    })

    const result = benchClientWorkspaceContext(benchPath)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('bench')
    expect(result!.cwd).toBe(benchPath)
    expect(result!.bench).toBeDefined()
    expect(result!.bench!.benchPath).toBe(benchPath)
    expect(result!.bench!.members).toBeDefined()
    expect(result!.text).toContain(BENCH_CONTEXT_MARKER)
    // data must NOT be set -- the bench record goes into bench, not data
    expect((result as unknown as Record<string, unknown>).data).toBeUndefined()
  })

  it('returns null on a corrupt record (fail open)', () => {
    writeFileSync(join(home, '.ion', 'integration-workspaces.json'), 'not json {{{')
    expect(benchClientWorkspaceContext(benchPath)).toBeNull()
  })
})
