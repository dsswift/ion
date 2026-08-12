/**
 * Attribution behaviour: the outcomes, the precision claims, and the failure
 * modes. Ported from engine/internal/workspaces/attribution_test.go. Every
 * test here runs against the real-git fixture in bench-test-fixture.ts,
 * because each property being asserted is a property of blame/ancestry/merge
 * commits rather than of this module's bookkeeping.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync } from 'fs'
import { removeGitFixture } from '../../test/git-fixture-cleanup'
import { join } from 'path'
import { GIT_FIXTURE_TIMEOUT } from '../../test/git-fixture-timeout'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

// Redirect HOME so the workspace records land in a fixture, never the
// developer's ~/.ion. Per-file env var: vitest runs test FILES concurrently in
// one process, so a shared name would let files clobber each other's fake home.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_BENCH_ATTR || actual.homedir() }
})

import { attribute } from '../integration/bench-attribution'
import {
  setAttributionGitForTest, realGitRunner,
  type AttributionRequest, type AttributionResult, type AttributionCandidate, type LineRange,
} from '../integration/bench-attribution-support'
import {
  type BenchFixture, assemble, buildMembers, git, gitTry, initBenchFixture, lineOf,
  memberRecord, readLinesOf, writeLines, writeRecord, writeWorktreeEntries,
} from '../integration/bench-test-fixture'

let f: BenchFixture

beforeEach(() => {
  f = initBenchFixture('ion-benchattr-')
  process.env.ION_TEST_HOME_BENCH_ATTR = f.ionHome
})

afterEach(() => {
  setAttributionGitForTest(null)
  delete process.env.ION_TEST_HOME_BENCH_ATTR
  removeGitFixture(f.root)
})

function attr(req: Partial<AttributionRequest>): AttributionResult {
  return attribute({ benchPath: f.benchPath, path: '', ...req } as AttributionRequest)
}

function candidateFor(res: AttributionResult, branch: string): AttributionCandidate {
  const c = res.candidates.find((cc) => cc.branchName === branch)
  if (!c) throw new Error(`no candidate for ${branch} in ${JSON.stringify(res, null, 2)}`)
  return c
}
function hasCandidate(res: AttributionResult, branch: string): boolean {
  return res.candidates.some((c) => c.branchName === branch)
}
function rangesContain(ranges: LineRange[] | undefined, line: number): boolean {
  return (ranges ?? []).some((r) => line >= r.start && line <= r.end)
}
function anyContains(haystack: string[] | undefined, needle: string): boolean {
  return (haystack ?? []).some((h) => h.includes(needle))
}

describe('line-level precision', () => {
  // THE precision test. alpha edits app.txt line 8; beta then inserts 5 lines
  // above it, so in the assembled bench that content sits at line 13. An
  // answer derived from alpha's own diff coordinates would look for line 13 in
  // a diff that only mentions line 8 and report the wrong owner (or none).
  // Blame over the assembled tree is what makes the shifted line resolve.
  it('resolves a shifted line to its real owner', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/beta')

    const shifted = lineOf(f, 'app.txt', 'line 08 changed by alpha')
    expect(shifted).not.toBe(8) // otherwise the test cannot prove shift-awareness

    const res = attr({ path: 'app.txt', startLine: shifted })

    expect(res.outcome).toBe('member')
    const owner = candidateFor(res, 'wt/alpha')
    expect(rangesContain(owner.matchedLines, shifted)).toBe(true)
    // The owning commit is reported so the claim is checkable.
    expect(owner.commits?.length ?? 0).toBeGreaterThan(0)
    // The tip-only shortcut's failure is pinned explicitly: alpha's TIP commit
    // touches only alpha_only.txt, so any implementation that asked about the
    // tip would not have named alpha here at all.
    expect(owner.status).toBe('changed')
  }, GIT_FIXTURE_TIMEOUT)

  // beta's own inserted line resolves to beta, so the shift test above is not
  // passing by accident of every line resolving to alpha.
  it('resolves an inserting member to itself', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/beta')

    const header = lineOf(f, 'app.txt', 'beta header 3')
    const res = attr({ path: 'app.txt', startLine: header })

    expect(res.outcome).toBe('member')
    expect(rangesContain(candidateFor(res, 'wt/beta').matchedLines, header)).toBe(true)
  }, GIT_FIXTURE_TIMEOUT)
})

describe('source content', () => {
  // A line no member touched belongs to the source branch, and the outcome
  // says so explicitly rather than reporting "no owner found".
  it('reports a source-owned line', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/beta')

    const untouched = lineOf(f, 'app.txt', 'line 11')
    const res = attr({ path: 'app.txt', startLine: untouched })

    expect(res.outcome).toBe('source')
    expect(rangesContain(res.sourceLines, untouched)).toBe(true)
  }, GIT_FIXTURE_TIMEOUT)

  it('reports a source-owned file with zero candidates', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/beta')

    const res = attr({ path: 'source_only.txt' })

    expect(res.outcome).toBe('source')
    expect(res.candidates).toHaveLength(0)
    expect(res.lineScoped).toBe(false)
  }, GIT_FIXTURE_TIMEOUT)
})

describe('ambiguity: every candidate, never a guess', () => {
  // Two members changing one file is `ambiguous` with BOTH listed and each
  // one's exact changed ranges — not a coin flip.
  it('reports every candidate for a shared file', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/gamma')

    const res = attr({ path: 'app.txt' })

    expect(res.outcome).toBe('ambiguous')
    expect(res.candidates).toHaveLength(2)
    for (const branch of ['wt/alpha', 'wt/gamma']) {
      // Each must report the line ranges it changed, so the caller can choose.
      expect(candidateFor(res, branch).changedRanges?.length ?? 0).toBeGreaterThan(0)
    }
  }, GIT_FIXTURE_TIMEOUT)

  // A line-scoped question inside a shared file is NOT ambiguous: that is the
  // whole point of the line scope.
  it('disambiguates a shared file by line', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/gamma')

    const gammaLine = lineOf(f, 'app.txt', 'line 03 changed by gamma')
    const res = attr({ path: 'app.txt', startLine: gammaLine })

    expect(res.outcome).toBe('member')
    expect(rangesContain(candidateFor(res, 'wt/gamma').matchedLines, gammaLine)).toBe(true)
    if (hasCandidate(res, 'wt/alpha')) {
      // alpha must not be credited with gamma's line.
      expect(candidateFor(res, 'wt/alpha').matchedLines ?? []).toHaveLength(0)
    }
  }, GIT_FIXTURE_TIMEOUT)

  // A range spanning two members' lines reports BOTH with their own matched
  // spans, so a caller editing that range knows it must split the fix.
  it('splits a range across two owners', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/gamma')

    const gammaLine = lineOf(f, 'app.txt', 'line 03 changed by gamma')
    const alphaLine = lineOf(f, 'app.txt', 'line 08 changed by alpha')
    const res = attr({ path: 'app.txt', startLine: gammaLine, endLine: alphaLine })

    expect(res.outcome).toBe('ambiguous')
    expect(rangesContain(candidateFor(res, 'wt/gamma').matchedLines, gammaLine)).toBe(true)
    expect(rangesContain(candidateFor(res, 'wt/alpha').matchedLines, alphaLine)).toBe(true)
    // The source lines between the two edits are reported too, so the answer
    // accounts for every requested line rather than only the interesting ones.
    expect(res.sourceLines?.length ?? 0).toBeGreaterThan(0)
  }, GIT_FIXTURE_TIMEOUT)
})

describe('conflict resolution', () => {
  // Content that exists only because a conflict resolution was recorded in an
  // assembly MERGE commit is `resolution`, not silently credited to whichever
  // side won. Editing one member may not reproduce it, which is precisely why
  // the distinction is load-bearing.
  it('reports a resolution-owned line', () => {
    const app = join(f.benchPath, 'app.txt')

    // Two members that change THE SAME line in different ways.
    git(f.benchPath, 'switch', '-c', 'wt/left', f.baseSha)
    let lines = readLinesOf(app)
    lines[5] = 'line 06 from left'
    writeLines(app, lines)
    git(f.benchPath, 'add', '-A')
    git(f.benchPath, 'commit', '-m', 'left')
    const leftPin = git(f.benchPath, 'rev-parse', 'HEAD').trim()

    git(f.benchPath, 'switch', '-c', 'wt/right', f.baseSha)
    lines = readLinesOf(app)
    lines[5] = 'line 06 from right'
    writeLines(app, lines)
    git(f.benchPath, 'add', '-A')
    git(f.benchPath, 'commit', '-m', 'right')
    const rightPin = git(f.benchPath, 'rev-parse', 'HEAD').trim()

    // Assemble: merge left cleanly, then merge right with a resolution that is
    // neither side's content.
    git(f.benchPath, 'switch', '-C', 'ion/bench/main', f.baseSha)
    git(f.benchPath, 'merge', '--no-ff', '-m', 'assembly: merge left', leftPin)
    expect(gitTry(f.benchPath, 'merge', '--no-ff', '-m', 'assembly: merge right', rightPin)).toBe(false)
    lines = readLinesOf(app)
    lines[5] = 'line 06 reconciled by the resolution'
    writeLines(app, lines)
    git(f.benchPath, 'add', 'app.txt')
    git(f.benchPath, 'commit', '--no-edit')

    writeRecord(f, [
      memberRecord({ worktreePath: '/wt/left', branchName: 'wt/left', pinnedSha: leftPin, pinnedBaseSha: f.baseSha }),
      memberRecord({
        worktreePath: '/wt/right', branchName: 'wt/right', pinnedSha: rightPin, pinnedBaseSha: f.baseSha,
        merge: 'conflicted', conflictPaths: ['app.txt'], conflictsWith: ['wt/left'],
      }),
    ])

    const resolved = lineOf(f, 'app.txt', 'reconciled by the resolution')
    const res = attr({ path: 'app.txt', startLine: resolved })

    expect(res.outcome).toBe('resolution')
    expect(rangesContain(res.resolutionLines, resolved)).toBe(true)
    // The warning is what tells a caller that editing one member may not
    // reproduce the line — the actionable half of the outcome.
    expect(anyContains(res.warnings, 'conflict resolution')).toBe(true)
  }, GIT_FIXTURE_TIMEOUT)
})

describe('disabled members', () => {
  // A disabled member's content is NOT in the bench, so it is never a
  // candidate — but it IS reported separately, because "the fix looks like it
  // belongs to a member that is switched off" is a real diagnosis and silence
  // reads as "no such member".
  it('separates disabled members from candidates', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')

    writeRecord(f, [
      memberRecord({ worktreePath: '/wt/alpha', branchName: 'wt/alpha', pinnedSha: f.pins['wt/alpha'], pinnedBaseSha: f.baseSha }),
      memberRecord({ worktreePath: '/wt/gamma', branchName: 'wt/gamma', enabled: false, pinnedSha: f.pins['wt/gamma'], pinnedBaseSha: f.baseSha }),
    ])

    const res = attr({ path: 'app.txt' })

    expect(hasCandidate(res, 'wt/gamma')).toBe(false)
    expect(res.disabledMembersTouching).toHaveLength(1)
    expect(res.disabledMembersTouching![0].branchName).toBe('wt/gamma')
    expect(anyContains(res.warnings, 'excluded from the assembly')).toBe(true)
    // With gamma excluded, alpha is the sole owner: the disabled member must
    // not have made the answer ambiguous.
    expect(res.outcome).toBe('member')
  }, GIT_FIXTURE_TIMEOUT)
})

describe('rename, delete, binary', () => {
  // A member that RENAMED the file is attributed, and the previous path is
  // reported — the path to edit in the member worktree differs from the
  // assembled one, so a redirect without it sends the caller to a file that
  // is not there.
  it('reports a rename with the previous path', () => {
    git(f.benchPath, 'switch', '-c', 'wt/renamer', f.baseSha)
    git(f.benchPath, 'mv', 'app.txt', 'renamed.txt')
    // A content change alongside the rename, so git's rename detection has a
    // similarity score to work with and the hunk ranges are non-empty.
    const lines = readLinesOf(join(f.benchPath, 'renamed.txt'))
    lines[0] = 'line 01 touched after the rename'
    writeLines(join(f.benchPath, 'renamed.txt'), lines)
    git(f.benchPath, 'add', '-A')
    git(f.benchPath, 'commit', '-m', 'renamer: move app.txt to renamed.txt')
    const pin = git(f.benchPath, 'rev-parse', 'HEAD').trim()

    git(f.benchPath, 'switch', '-C', 'ion/bench/main', f.baseSha)
    git(f.benchPath, 'merge', '--no-ff', '-m', 'assembly: merge renamer', pin)
    writeRecord(f, [memberRecord({ worktreePath: '/wt/renamer', branchName: 'wt/renamer', pinnedSha: pin, pinnedBaseSha: f.baseSha })])

    const res = attr({ path: 'renamed.txt' })

    expect(res.outcome).toBe('member')
    const cand = candidateFor(res, 'wt/renamer')
    expect(cand.status).toBe('renamed')
    expect(cand.renamedFrom).toBe('app.txt')
  }, GIT_FIXTURE_TIMEOUT)

  // A path DELETED in the assembled tree is still attributable from history,
  // and the result says the file is not there rather than returning a bare
  // empty answer that reads like "nothing owns it".
  it('handles a file deleted in the bench', () => {
    git(f.benchPath, 'switch', '-c', 'wt/deleter', f.baseSha)
    git(f.benchPath, 'rm', 'source_only.txt')
    git(f.benchPath, 'commit', '-m', 'deleter: remove source_only.txt')
    const pin = git(f.benchPath, 'rev-parse', 'HEAD').trim()

    git(f.benchPath, 'switch', '-C', 'ion/bench/main', f.baseSha)
    git(f.benchPath, 'merge', '--no-ff', '-m', 'assembly: merge deleter', pin)
    writeRecord(f, [memberRecord({ worktreePath: '/wt/deleter', branchName: 'wt/deleter', pinnedSha: pin, pinnedBaseSha: f.baseSha })])

    const res = attr({ path: 'source_only.txt' })

    expect(res.existsInBench).toBe(false)
    expect(res.deletedInBench).toBe(true)
    const cand = candidateFor(res, 'wt/deleter')
    expect(cand.status).toBe('deleted')
    // A deleted file has no line ranges in the new tree.
    expect(cand.changedRanges ?? []).toHaveLength(0)
  }, GIT_FIXTURE_TIMEOUT)

  // A line-scoped request against a deleted file cannot be answered by blame,
  // and says so in errors while the file-level answer still stands.
  it('refuses line scope on a deleted file', () => {
    git(f.benchPath, 'switch', '-c', 'wt/deleter', f.baseSha)
    git(f.benchPath, 'rm', 'source_only.txt')
    git(f.benchPath, 'commit', '-m', 'deleter: remove')
    const pin = git(f.benchPath, 'rev-parse', 'HEAD').trim()
    git(f.benchPath, 'switch', '-C', 'ion/bench/main', f.baseSha)
    git(f.benchPath, 'merge', '--no-ff', '-m', 'assembly', pin)
    writeRecord(f, [memberRecord({ worktreePath: '/wt/deleter', branchName: 'wt/deleter', pinnedSha: pin, pinnedBaseSha: f.baseSha })])

    const res = attr({ path: 'source_only.txt', startLine: 1 })

    expect(anyContains(res.errors, 'does not exist in the assembled bench tree')).toBe(true)
    // The file-level answer survives: the member is still named.
    expect(hasCandidate(res, 'wt/deleter')).toBe(true)
  }, GIT_FIXTURE_TIMEOUT)

  // A BINARY file has no lines. Ownership is reported per file, and a
  // line-scoped question is answered with an explicit error instead of a
  // fabricated span.
  it('handles a binary file', () => {
    git(f.benchPath, 'switch', '-c', 'wt/binary', f.baseSha)
    writeFileSync(join(f.benchPath, 'asset.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x42]))
    git(f.benchPath, 'add', '-A')
    git(f.benchPath, 'commit', '-m', 'binary: add asset')
    const pin = git(f.benchPath, 'rev-parse', 'HEAD').trim()

    git(f.benchPath, 'switch', '-C', 'ion/bench/main', f.baseSha)
    git(f.benchPath, 'merge', '--no-ff', '-m', 'assembly: merge binary', pin)
    writeRecord(f, [memberRecord({ worktreePath: '/wt/binary', branchName: 'wt/binary', pinnedSha: pin, pinnedBaseSha: f.baseSha })])

    const res = attr({ path: 'asset.bin' })
    expect(res.binary).toBe(true)
    // A binary file still has a file-level owner.
    expect(res.outcome).toBe('member')
    expect(anyContains(res.warnings, 'binary file')).toBe(true)

    const lineScoped = attr({ path: 'asset.bin', startLine: 1, endLine: 3 })
    expect(anyContains(lineScoped.errors, 'binary file, which has no lines')).toBe(true)
  }, GIT_FIXTURE_TIMEOUT)
})

describe('git errors: never a silent member omission', () => {
  // The single most dangerous failure mode. A member whose diff cannot be read
  // must still be LISTED with its error: dropping it is indistinguishable from
  // "this member does not own the file", which produces a wrong redirect with
  // full confidence.
  it('lists a member whose diff failed rather than omitting it', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha', 'wt/gamma')

    // Fail exactly the diff for gamma's pin, leave everything else real.
    const gammaPin = f.pins['wt/gamma']
    setAttributionGitForTest((dir, args) => {
      const joined = args.join(' ')
      if (joined.startsWith('diff') && joined.includes(gammaPin)) {
        return { out: '', error: `fatal: bad object ${gammaPin}`, code: 128 }
      }
      return realGitRunner(dir, args)
    })

    const res = attr({ path: 'app.txt' })

    const cand = candidateFor(res, 'wt/gamma')
    expect(cand.error).toBeTruthy()
    // The git error is surfaced verbatim enough to act on.
    expect(cand.error).toContain('bad object')
    expect(anyContains(res.errors, 'bad object')).toBe(true)
    // A read that failed cannot yield a confident single owner.
    expect(res.outcome).not.toBe('member')
  }, GIT_FIXTURE_TIMEOUT)

  // When EVERY member read fails, the outcome is `unknown` — never `source`,
  // which would be a confident claim built on nothing.
  it('is unknown when every member read fails', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')

    setAttributionGitForTest((dir, args) => {
      if (args.join(' ').startsWith('diff --name-status')) {
        return { out: '', error: 'fatal: not a git repository', code: 128 }
      }
      return realGitRunner(dir, args)
    })

    const res = attr({ path: 'app.txt' })
    expect(res.outcome).toBe('unknown')
  }, GIT_FIXTURE_TIMEOUT)

  // A blame failure is reported and the requested lines land in unknownLines,
  // so the caller learns which lines have no answer instead of receiving a
  // truncated one that looks complete.
  it('surfaces a blame failure', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')

    setAttributionGitForTest((dir, args) => {
      if (args[0] === 'blame') {
        return { out: '', error: 'fatal: file has only 12 lines', code: 128 }
      }
      return realGitRunner(dir, args)
    })

    const res = attr({ path: 'app.txt', startLine: 4, endLine: 6 })

    expect(anyContains(res.errors, 'git blame failed')).toBe(true)
    expect(rangesContain(res.unknownLines, 5)).toBe(true)
    expect(res.outcome).toBe('unknown')
  }, GIT_FIXTURE_TIMEOUT)

  // A missing member object is reported as such rather than as a quiet "this
  // member does not own it". A garbage-collected pin is the realistic cause.
  it('surfaces a missing member object', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')

    // A pin that is a well-formed sha but not present in the repository.
    writeRecord(f, [memberRecord({
      worktreePath: '/wt/ghost', branchName: 'wt/ghost',
      pinnedSha: '0000000000000000000000000000000000000001', pinnedBaseSha: f.baseSha,
    })])

    const res = attr({ path: 'app.txt' })

    const cand = candidateFor(res, 'wt/ghost')
    expect(cand.error).toBeTruthy()
    // The only member being unreadable means unknown.
    expect(res.outcome).toBe('unknown')
  }, GIT_FIXTURE_TIMEOUT)
})

describe('missing base / no range', () => {
  // A bench with no baseSha and a member with no pinnedBaseSha has no
  // contribution range to diff. That is stated as an error on the candidate
  // and a warning on the result, not silently treated as "no changes".
  it('reports a missing contribution range', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')

    writeRecord(
      f,
      [memberRecord({ worktreePath: '/wt/alpha', branchName: 'wt/alpha', pinnedSha: f.pins['wt/alpha'] })],
      { baseSha: '' },
    )

    const res = attr({ path: 'app.txt' })

    expect(anyContains(res.warnings, 'no baseSha')).toBe(true)
    const cand = candidateFor(res, 'wt/alpha')
    expect(cand.error).toContain('range')
    expect(res.outcome).toBe('unknown')
  }, GIT_FIXTURE_TIMEOUT)

  // A member with no pinnedSha at all is listed with its error rather than
  // skipped, for the same reason a failed diff is.
  it('reports a member with no pin', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')

    writeRecord(f, [memberRecord({ worktreePath: '/wt/unpinned', branchName: 'wt/unpinned' })])

    const res = attr({ path: 'app.txt' })
    expect(candidateFor(res, 'wt/unpinned').error).toContain('no pinnedSha')
  }, GIT_FIXTURE_TIMEOUT)
})

describe('worktree registry join', () => {
  // A candidate carries the operator-facing TITLE of the owning worktree,
  // joined from the worktree registry. A redirect that names only a path and a
  // branch makes the caller guess which piece of work it is being sent into;
  // the title is the label the operator already recognizes.
  it('joins the worktree title into candidates', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')
    writeWorktreeEntries(f, [{
      worktreePath: '/wt/alpha', repoPath: f.repo, branchName: 'wt/alpha',
      sourceBranch: 'main', createdAt: 1, title: 'fix the streaming retry loop',
    }])

    const res = attr({ path: 'app.txt' })
    expect(candidateFor(res, 'wt/alpha').title).toBe('fix the streaming retry loop')
  }, GIT_FIXTURE_TIMEOUT)

  // A member with no registry entry still attributes — the title is
  // decoration, never a precondition. A missing entry silently dropping the
  // candidate would be the same defect as a silent member omission.
  it('succeeds when the worktree registry has no entry', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')
    writeWorktreeEntries(f, [])

    const res = attr({ path: 'app.txt' })
    expect(res.outcome).toBe('member')
    expect(candidateFor(res, 'wt/alpha').title).toBeUndefined()
  }, GIT_FIXTURE_TIMEOUT)
})

describe('request validation', () => {
  it('rejects a directory that is not a bench', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')

    const res = attribute({ benchPath: join(f.root, 'elsewhere'), path: 'app.txt' })
    expect(res.rejection).toBeTruthy()
    expect(res.outcome).toBe('unknown')
  }, GIT_FIXTURE_TIMEOUT)

  it('rejects paths outside the bench, distinguishing traversal', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')

    const traversal = attr({ path: '../escape.txt' })
    expect(traversal.rejection).toContain('escapes the bench')

    const outside = attr({ path: '/etc/passwd' })
    expect(outside.rejection).toContain('outside the bench')
  }, GIT_FIXTURE_TIMEOUT)

  // An invalid range is REJECTED rather than silently widened to the whole
  // file: a caller asking about lines 40-30 has a bug, and answering about the
  // entire file would look like a successful answer.
  it('rejects invalid line ranges', () => {
    buildMembers(f)
    assemble(f, 'wt/alpha')

    expect(attr({ path: 'app.txt', startLine: 40, endLine: 30 }).rejection).toContain('before startLine')
    expect(attr({ path: 'app.txt', endLine: 5 }).rejection).toContain('without a startLine')
  }, GIT_FIXTURE_TIMEOUT)
})
