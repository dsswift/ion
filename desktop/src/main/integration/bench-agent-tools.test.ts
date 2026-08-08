/**
 * Bench agent tools — the desktop's client-tool handlers for the three
 * read-only bench provenance tools.
 *
 * Ported from engine/internal/workspaces/member_file_test.go and
 * resolution_history_test.go, plus the input-validation arms of
 * engine/internal/tools. Member-file properties run against the real-git
 * fixture in bench-test-fixture.ts: the content must come from the recorded
 * PIN and be labelled with where it came from — not from a member worktree's
 * current files, and not unlabelled, which is how two versions of one file get
 * confused for each other.
 *
 * The resolution-history half reuses the journal-format fixture
 * (src/main/__tests__/testdata/integration-resolutions.fixture.json): the
 * desktop writes the journal and reads it back here, and both suites assert
 * against the same artifact so a field rename on either side fails a test
 * instead of silently dropping the field.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { GIT_FIXTURE_TIMEOUT } from '../../test/git-fixture-timeout'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// Redirect HOME so the records land in a fixture, never the developer's
// ~/.ion. Per-file env var: vitest runs test FILES concurrently in one process.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_TOOLS || actual.homedir() }
})

import {
  BENCH_CLIENT_TOOLS,
  executeBenchMemberFile,
  executeBenchResolutionHistory,
  executeWorkspaceAttribution,
  DEFAULT_RESOLUTION_HISTORY_LIMIT,
  type ResolutionHistoryResult,
} from '../integration/bench-agent-tools'
import { memberFile, MAX_MEMBER_FILE_BYTES, type MemberFileResult } from '../integration/bench-member-file'
import {
  type BenchFixture, assemble, buildMembers, git, initBenchFixture,
  memberRecord, readLinesOf, writeLines, writeRecord, writeResolutions,
} from '../integration/bench-test-fixture'

let f: BenchFixture

beforeEach(() => {
  f = initBenchFixture('ion-benchtools-')
  process.env.ION_TEST_HOME_BENCH_TOOLS = f.ionHome
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_BENCH_TOOLS
  rmSync(f.root, { recursive: true, force: true })
})

/** One journal entry with this bench's repo/branch identity. */
function resolution(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repoPath: f.repo,
    sourceBranch: 'main',
    benchBranch: 'ion/bench/main',
    path: 'app.txt',
    memberBranch: 'wt/alpha',
    collidedWith: ['wt/beta'],
    baseSha: f.baseSha,
    memberPinnedSha: 'pin111',
    resolvedSha: 'res111',
    resolvedAt: 1000,
    verified: true,
    rationale: "kept beta's header and layered alpha's edit under it",
    ...over,
  }
}

function historyOf(input: Record<string, unknown>, cwd?: string): ResolutionHistoryResult {
  const res = executeBenchResolutionHistory(input, cwd ?? f.benchPath)
  return JSON.parse(res.content) as ResolutionHistoryResult
}

// ─── BenchMemberFile ──────────────────────────────────────────────────────────

describe('BenchMemberFile', () => {
  it('returns the pinned contribution, not the assembled tree', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/beta')

    const res = memberFile({ benchPath: f.benchPath, path: 'app.txt', member: 'wt/alpha' })

    expect(res.rejection).toBeUndefined()
    expect(res.exists).toBe(true)
    // alpha's own version: its edit present, beta's header absent. That is the
    // distinguishing assertion — the ASSEMBLED file contains both.
    expect(res.content).toContain('line 08 changed by alpha')
    expect(res.content).not.toContain('beta header 1')
  }, GIT_FIXTURE_TIMEOUT)

  it('names where the content came from', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/beta')

    const res = memberFile({ benchPath: f.benchPath, path: 'app.txt', member: 'wt/beta' })

    // Unlabelled content is how two members' versions get confused. The
    // member, its worktree, the pinned sha, and the exact revision all ride.
    expect(res.memberBranch).toBe('wt/beta')
    expect(res.memberWorktreePath).toBe('/wt/beta')
    expect(res.pinnedSha).toBe(f.pins['wt/beta'])
    expect(res.revision).toBe(`${f.pins['wt/beta']}:app.txt`)
    expect(res.source).toBe('member')
  }, GIT_FIXTURE_TIMEOUT)

  it('addresses a member by branch or worktree path', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/beta')

    // A caller rarely has both: the prompt context lists both, a conflict
    // report names branches, attribution returns worktree paths.
    const byBranch = memberFile({ benchPath: f.benchPath, path: 'app.txt', member: 'wt/alpha' })
    const byPath = memberFile({ benchPath: f.benchPath, path: 'app.txt', member: '/wt/alpha' })

    expect(byBranch.content).toBeTruthy()
    expect(byBranch.content).toBe(byPath.content)
  }, GIT_FIXTURE_TIMEOUT)

  it('reads the bench base', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/beta')

    const res = memberFile({ benchPath: f.benchPath, path: 'app.txt', source: 'base' })

    expect(res.rejection).toBeUndefined()
    // The common ancestor: neither member's change is in it.
    expect(res.content).not.toContain('changed by alpha')
    expect(res.content).not.toContain('beta header')
    expect(res.content).toContain('line 08')
    // A base read needs no member, and must not claim one.
    expect(res.memberBranch).toBeUndefined()
    expect(res.pinnedSha).toBeUndefined()
  }, GIT_FIXTURE_TIMEOUT)

  it('reports an absent path as an answer', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/beta')

    // alpha_only.txt exists in alpha and nowhere else. "beta does not have it"
    // is a real, useful answer (it tells the resolver beta added nothing
    // here), not a failure.
    const res = memberFile({ benchPath: f.benchPath, path: 'alpha_only.txt', member: 'wt/beta' })

    expect(res.rejection).toBeUndefined()
    expect(res.exists).toBe(false)
    // The absent case is stated in words, not left as an empty content field.
    expect(res.warnings?.length ?? 0).toBeGreaterThan(0)
  }, GIT_FIXTURE_TIMEOUT)

  it('refuses a path outside the bench', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')

    for (const path of ['../escape.txt', '/etc/passwd']) {
      const res = memberFile({ benchPath: f.benchPath, path, member: 'wt/alpha' })
      expect(res.rejection, path).toBeTruthy()
    }
  }, GIT_FIXTURE_TIMEOUT)

  it('refuses outside a bench', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')

    const res = memberFile({ benchPath: join(f.root, 'elsewhere'), path: 'app.txt', member: 'wt/alpha' })
    expect(res.rejection).toBeTruthy()
  }, GIT_FIXTURE_TIMEOUT)

  it('refuses a disabled member rather than answering quietly', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/beta')
    // Re-record beta as DISABLED: its content is not in the bench.
    writeRecord(f, [
      memberRecord({ worktreePath: '/wt/alpha', branchName: 'wt/alpha', pinnedSha: f.pins['wt/alpha'], pinnedBaseSha: f.baseSha }),
      memberRecord({ worktreePath: '/wt/beta', branchName: 'wt/beta', enabled: false, pinnedSha: f.pins['wt/beta'], pinnedBaseSha: f.baseSha }),
    ])

    const res = memberFile({ benchPath: f.benchPath, path: 'app.txt', member: 'wt/beta' })

    // Returning it silently would answer a question the caller did not ask:
    // the file they are looking at cannot have come from a skipped member.
    expect(res.rejection).toBeTruthy()
    expect(res.rejection).toContain('DISABLED')
  }, GIT_FIXTURE_TIMEOUT)

  it('lists the enabled members when the name does not match', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/beta')

    const res = memberFile({ benchPath: f.benchPath, path: 'app.txt', member: 'wt/nope' })

    expect(res.rejection).toBeTruthy()
    // Listed so a caller that guessed wrong can correct itself without a
    // second round trip — the whole point of replacing a shell sweep with a
    // primitive.
    expect(res.members?.map((m) => m.branchName)).toHaveLength(2)
  }, GIT_FIXTURE_TIMEOUT)

  it('requires a member for a member read', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')

    const res = memberFile({ benchPath: f.benchPath, path: 'app.txt' })
    // Refused, not defaulted.
    expect(res.rejection).toBeTruthy()
  }, GIT_FIXTURE_TIMEOUT)

  it('warns when the member has moved past its pin', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')
    // Pin and current tree disagree: the worktree has moved on.
    writeRecord(f, [memberRecord({
      worktreePath: '/wt/alpha', branchName: 'wt/alpha',
      pinnedSha: f.pins['wt/alpha'], pinnedBaseSha: f.baseSha,
      pinnedTreeHash: 'aaa', currentTreeHash: 'bbb',
    })])

    const res = memberFile({ benchPath: f.benchPath, path: 'app.txt', member: 'wt/alpha' })

    // The content is still the right answer — the bench merges the pin — but a
    // reader comparing it against the member's worktree would find a
    // difference and needs to know why.
    expect(res.content).toBeTruthy()
    expect(res.warnings?.length ?? 0).toBeGreaterThan(0)
  }, GIT_FIXTURE_TIMEOUT)

  it('truncates rather than flooding the caller', () => {
    buildMembers(f)

    // A file larger than the cap, committed on a member branch.
    git(f.benchPath, 'switch', 'wt/alpha')
    writeLines(join(f.benchPath, 'big.txt'), ['x'.repeat(MAX_MEMBER_FILE_BYTES + 4096)])
    git(f.benchPath, 'add', '-A')
    git(f.benchPath, 'commit', '-m', 'alpha: big file')
    f.pins['wt/alpha'] = git(f.benchPath, 'rev-parse', 'HEAD').trim()
    git(f.benchPath, 'switch', 'main')
    assemble(f, 'wt/alpha')

    const res = memberFile({ benchPath: f.benchPath, path: 'big.txt', member: 'wt/alpha' })

    expect(res.truncated).toBe(true)
    expect(res.content!.length).toBeLessThanOrEqual(MAX_MEMBER_FILE_BYTES)
    // Silently cutting is indistinguishable from a short file, so the
    // truncation is stated in words as well as in the flag.
    expect(res.warnings?.length ?? 0).toBeGreaterThan(0)
    // bytes reports the FULL size, not the truncated length.
    expect(res.bytes).toBeGreaterThan(MAX_MEMBER_FILE_BYTES)
  }, GIT_FIXTURE_TIMEOUT)

  it('reports binary without dumping it', () => {
    buildMembers(f)

    git(f.benchPath, 'switch', 'wt/alpha')
    // A blob git classifies as binary (NUL bytes in the first 8000, which is
    // git's own heuristic).
    const data = Buffer.alloc(512)
    for (let i = 0; i < data.length; i++) data[i] = i % 3 === 0 ? 0 : i % 251
    writeFileSync(join(f.benchPath, 'logo.bin'), data)
    git(f.benchPath, 'add', '-A')
    git(f.benchPath, 'commit', '-m', 'alpha: binary')
    f.pins['wt/alpha'] = git(f.benchPath, 'rev-parse', 'HEAD').trim()
    git(f.benchPath, 'switch', 'main')
    assemble(f, 'wt/alpha')

    const res = memberFile({ benchPath: f.benchPath, path: 'logo.bin', member: 'wt/alpha' })

    expect(res.binary).toBe(true)
    expect(res.content ?? '').toBe('')
    // Stated, so a missing content field is not read as empty.
    expect(res.warnings?.length ?? 0).toBeGreaterThan(0)
  }, GIT_FIXTURE_TIMEOUT)

  it('handler validates input and serializes the result', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')

    expect(executeBenchMemberFile({}, f.benchPath)).toEqual({ content: 'Error: file is required', isError: true })
    expect(executeBenchMemberFile({ file: 'app.txt', source: 'nope' }, f.benchPath).isError).toBe(true)

    const ok = executeBenchMemberFile({ file: 'app.txt', member: 'wt/alpha' }, f.benchPath)
    expect(ok.isError).toBe(false)
    const parsed = JSON.parse(ok.content) as MemberFileResult
    expect(parsed.memberBranch).toBe('wt/alpha')
    expect(parsed.content).toContain('line 08 changed by alpha')

    // A rejection rides the JSON result but flips isError so the model sees an
    // actionable refusal rather than a success carrying one it might ignore.
    const rejected = executeBenchMemberFile({ file: 'app.txt', member: 'wt/nope' }, f.benchPath)
    expect(rejected.isError).toBe(true)
    expect((JSON.parse(rejected.content) as MemberFileResult).rejection).toBeTruthy()
  }, GIT_FIXTURE_TIMEOUT)
})

// ─── BenchResolutionHistory ──────────────────────────────────────────────────

describe('BenchResolutionHistory', () => {
  it('returns entries for the bench with every field intact', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/beta')
    writeResolutions(f, [resolution()])

    const res = historyOf({})

    expect(res.rejection).toBeUndefined()
    expect(res.entries).toHaveLength(1)
    const e = res.entries[0]
    // Every field the resolver needs, carried through the JSON boundary.
    expect(e.path).toBe('app.txt')
    expect(e.memberBranch).toBe('wt/alpha')
    expect(e.collidedWith).toEqual(['wt/beta'])
    // The rationale is the entire point of the journal.
    expect(e.rationale).toBeTruthy()
    expect(e.verified).toBe(true)
  }, GIT_FIXTURE_TIMEOUT)

  it('narrows to requested paths', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')
    writeResolutions(f, [
      resolution({ path: 'app.txt' }),
      resolution({ path: 'alpha_only.txt' }),
    ])

    const res = historyOf({ paths: ['app.txt'] })
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0].path).toBe('app.txt')
  }, GIT_FIXTURE_TIMEOUT)

  it('accepts an absolute path', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')
    writeResolutions(f, [resolution()])

    // A caller holding an absolute path (from a build error, from attribution)
    // must not have to relativize it first.
    const res = historyOf({ paths: [join(f.benchPath, 'app.txt')] })
    expect(res.entries).toHaveLength(1)
  }, GIT_FIXTURE_TIMEOUT)

  it('orders newest first', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')
    writeResolutions(f, [
      resolution({ resolvedAt: 100, memberBranch: 'wt/old' }),
      resolution({ resolvedAt: 300, memberBranch: 'wt/new' }),
      resolution({ resolvedAt: 200, memberBranch: 'wt/mid' }),
    ])

    const res = historyOf({})
    // The most recent decision about a file is the one most likely to still
    // describe the code.
    expect(res.entries.map((e) => e.memberBranch)).toEqual(['wt/new', 'wt/mid', 'wt/old'])
  }, GIT_FIXTURE_TIMEOUT)

  it('never leaks another bench', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')
    writeResolutions(f, [
      resolution(),
      resolution({ sourceBranch: 'other-branch', memberBranch: 'wt/elsewhere' }),
      resolution({ repoPath: '/some/other/repo', memberBranch: 'wt/otherrepo' }),
    ])

    const res = historyOf({})
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0].memberBranch).toBe('wt/alpha')
  }, GIT_FIXTURE_TIMEOUT)

  it('bounds an unnarrowed query', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')
    const many: Record<string, unknown>[] = []
    for (let i = 0; i < DEFAULT_RESOLUTION_HISTORY_LIMIT + 5; i++) {
      many.push(resolution({ resolvedAt: i }))
    }
    writeResolutions(f, many)

    const res = historyOf({})

    expect(res.entries).toHaveLength(DEFAULT_RESOLUTION_HISTORY_LIMIT)
    // total is the full match count before the cap.
    expect(res.total).toBe(DEFAULT_RESOLUTION_HISTORY_LIMIT + 5)
    // A silently capped list looks like a complete one; say so.
    expect(res.truncated).toBe(true)
  }, GIT_FIXTURE_TIMEOUT)

  it('honours an explicit limit', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')
    writeResolutions(f, [resolution({ resolvedAt: 100 }), resolution({ resolvedAt: 200 })])

    const res = historyOf({ limit: 1 })
    expect(res.entries).toHaveLength(1)
    expect(res.total).toBe(2)
    expect(res.truncated).toBe(true)
  }, GIT_FIXTURE_TIMEOUT)

  it('is empty with no journal', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')

    const res = historyOf({})

    // Nothing recorded yet is the normal state of a new bench, not an error
    // and not a warning.
    expect(res.rejection).toBeUndefined()
    expect(res.entries).toHaveLength(0)
    expect(res.warnings ?? []).toHaveLength(0)
  }, GIT_FIXTURE_TIMEOUT)

  it('warns on a corrupt journal', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')
    writeFileSync(join(f.ionHome, '.ion', 'integration-resolutions.json'), '{ not json')

    const res = historyOf({})

    // Advisory reads never break the caller — but silence would make a corrupt
    // journal indistinguishable from an empty one, and this is a state someone
    // has to fix.
    expect(res.warnings?.length ?? 0).toBeGreaterThan(0)
    expect(res.entries).toHaveLength(0)
  }, GIT_FIXTURE_TIMEOUT)

  it('refuses outside a bench', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')

    const res = historyOf({}, join(f.root, 'elsewhere'))
    expect(res.rejection).toBeTruthy()
  }, GIT_FIXTURE_TIMEOUT)

  it('refuses a path outside the bench', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')
    writeResolutions(f, [resolution()])

    // Refused, not silently ignored.
    const res = executeBenchResolutionHistory({ paths: ['../escape.txt'] }, f.benchPath)
    expect(res.isError).toBe(true)
    expect((JSON.parse(res.content) as ResolutionHistoryResult).rejection).toBeTruthy()
  }, GIT_FIXTURE_TIMEOUT)

  it('rejects malformed input shapes', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')

    // A bare string is a misread schema, not a one-element array.
    expect(executeBenchResolutionHistory({ paths: 'a.ts' }, f.benchPath))
      .toEqual({ content: 'Error: paths must be an array of strings', isError: true })
    expect(executeBenchResolutionHistory({ paths: [1] }, f.benchPath).isError).toBe(true)
    expect(executeBenchResolutionHistory({ limit: 0 }, f.benchPath))
      .toEqual({ content: 'Error: limit must be 1 or greater', isError: true })
    expect(executeBenchResolutionHistory({ limit: 1.5 }, f.benchPath).isError).toBe(true)
  }, GIT_FIXTURE_TIMEOUT)

  /**
   * The journal format contract.
   *
   * The journal is written by bench-resolution-journal.ts and read here; the
   * pinned fixture (desktop-local since the bench agent surface moved to the
   * desktop's client tool gate) is the artifact every reader asserts against.
   * If a field is renamed on either side without updating it, the entry
   * silently loses that field and the reader reports a resolution with no
   * rationale — the exact failure that makes the journal worthless while
   * looking like it works.
   */
  it('reads the pinned fixture format', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/beta')

    const fixturePath = resolve(
      __dirname, '../__tests__/testdata/integration-resolutions.fixture.json',
    )
    const parsed = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
      version: number
      entries: Record<string, unknown>[]
    }
    // The fixture is repo/branch-agnostic; rewrite its identity onto this
    // bench so the FORMAT is what is under test rather than the fixture paths.
    for (const e of parsed.entries) {
      e.repoPath = f.repo
      e.sourceBranch = 'main'
    }
    writeResolutions(f, parsed.entries)

    const res = historyOf({})

    // Read every fixture entry — a lost one means a field the writer emits is
    // not being decoded.
    expect(res.entries).toHaveLength(parsed.entries.length)
    const e = res.entries[0]
    // Assert every field individually: a missing one decodes to undefined,
    // which is indistinguishable from "the writer did not set it".
    expect(e.path).toBeTruthy()
    expect(e.memberBranch).toBeTruthy()
    expect(e.collidedWith.length).toBeGreaterThan(0)
    expect(e.baseSha).toBeTruthy() // staleness pruning depends on it
    expect(e.memberPinnedSha).toBeTruthy()
    expect(e.resolvedSha).toBeTruthy()
    expect(e.resolvedAt).toBeGreaterThan(0) // ordering depends on it
    expect(e.rationale).toBeTruthy() // the whole reason the journal exists
    expect(e.benchBranch).toBeTruthy()
  }, GIT_FIXTURE_TIMEOUT)
})

// ─── WorkspaceAttribution handler ────────────────────────────────────────────

describe('WorkspaceAttribution handler', () => {
  it('validates input before running attribution', () => {
    expect(executeWorkspaceAttribution({}, f.benchPath))
      .toEqual({ content: 'Error: file is required', isError: true })
    expect(executeWorkspaceAttribution({ file: 'a.txt', line: 0 }, f.benchPath))
      .toEqual({ content: 'Error: line must be 1 or greater', isError: true })
    expect(executeWorkspaceAttribution({ file: 'a.txt', line: 1.5 }, f.benchPath))
      .toEqual({ content: 'Error: line must be an integer', isError: true })
    expect(executeWorkspaceAttribution({ file: 'a.txt', endLine: 3 }, f.benchPath))
      .toEqual({ content: 'Error: endLine requires line', isError: true })
    expect(executeWorkspaceAttribution({ file: 'a.txt', line: 5, endLine: 3 }, f.benchPath))
      .toEqual({ content: 'Error: endLine must be greater than or equal to line', isError: true })
  })

  it('runs attribution end to end and serializes the result', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/beta')

    const shiftedContent = readLinesOf(join(f.benchPath, 'app.txt'))
    const shifted = shiftedContent.findIndex((l) => l.includes('line 08 changed by alpha')) + 1
    const res = executeWorkspaceAttribution({ file: 'app.txt', line: shifted }, f.benchPath)

    expect(res.isError).toBe(false)
    const parsed = JSON.parse(res.content) as {
      outcome: string
      candidates: { branchName?: string; matchedLines?: { start: number; end: number }[] }[]
    }
    expect(parsed.outcome).toBe('member')
    const alpha = parsed.candidates.find((c) => c.branchName === 'wt/alpha')
    expect(alpha?.matchedLines?.some((r) => shifted >= r.start && shifted <= r.end)).toBe(true)
  }, GIT_FIXTURE_TIMEOUT)

  it('maps a rejection to an error result carrying the JSON payload', () => {
    const res = executeWorkspaceAttribution({ file: 'a.txt' }, join(f.root, 'elsewhere'))
    expect(res.isError).toBe(true)
    const parsed = JSON.parse(res.content) as { rejection?: string; outcome: string }
    expect(parsed.rejection).toBeTruthy()
    expect(parsed.outcome).toBe('unknown')
  }, GIT_FIXTURE_TIMEOUT)
})

// ─── Declarations ────────────────────────────────────────────────────────────

describe('BENCH_CLIENT_TOOLS declarations', () => {
  it('declares the three tools with their engine names, plan-mode safe', () => {
    expect(BENCH_CLIENT_TOOLS.map((t) => t.name))
      .toEqual(['WorkspaceAttribution', 'BenchMemberFile', 'BenchResolutionHistory'])
    for (const tool of BENCH_CLIENT_TOOLS) {
      expect(tool.planModeSafe).toBe(true)
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema.type).toBe('object')
      expect(typeof tool.execute).toBe('function')
    }
  })

  it('requires file on the two file-scoped tools and nothing on history', () => {
    const [attribution, member, history] = BENCH_CLIENT_TOOLS
    expect(attribution.inputSchema.required).toEqual(['file'])
    expect(member.inputSchema.required).toEqual(['file'])
    expect(history.inputSchema.required).toBeUndefined()
  })

  it('routes execute to the exported handlers', () => {
    const [attribution, member, history] = BENCH_CLIENT_TOOLS
    expect(attribution.execute).toBe(executeWorkspaceAttribution)
    expect(member.execute).toBe(executeBenchMemberFile)
    expect(history.execute).toBe(executeBenchResolutionHistory)
  })
})
