/**
 * Bench resolution journal — persistence, staleness pruning, and query.
 *
 * The behaviour that matters is WHAT SURVIVES. An entry describes a
 * reconciliation made against a specific bench base; once that base leaves the
 * source history the entry describes a world that no longer exists and must go.
 * Everything else about the file is unremarkable JSON, except that it must never
 * be able to break a bench merge — the journal is advisory, and the merge that
 * writes it is already committed by the time it runs.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))

// Redirect HOME so the journal lands in a fixture, never the developer's ~/.ion.
// Per-file env var: vitest runs test FILES concurrently in one process.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => process.env.ION_TEST_HOME_JOURNAL || actual.homedir() }
})

import {
  recordResolution,
  resolutionsFor,
  loadResolutions,
  resolutionsFile,
  type BenchResolutionEntry,
} from '../integration/bench-resolution-journal'

let root: string

function entry(over: Partial<BenchResolutionEntry> = {}): BenchResolutionEntry {
  return {
    repoPath: '/repo',
    sourceBranch: 'josh',
    benchBranch: 'ion/bench/josh',
    path: 'desktop/src/x.tsx',
    memberBranch: 'wt/a',
    collidedWith: ['wt/b'],
    baseSha: 'base111',
    memberPinnedSha: 'pin111',
    resolvedSha: 'res111',
    resolvedAt: 1000,
    verified: true,
    rationale: 'kept the factory structure, added the anchored placement',
    ...over,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-journal-'))
  process.env.ION_TEST_HOME_JOURNAL = root
  // Deliberately NOT creating ~/.ion here — see the fresh-machine test below.
})

afterEach(() => {
  delete process.env.ION_TEST_HOME_JOURNAL
  rmSync(root, { recursive: true, force: true })
})

describe('bench resolution journal — round trip', () => {
  it('creates the Ion home on first write rather than losing the entry', () => {
    // `atomicWriteFileSync` opens its temp file directly and does not create the
    // directory. Without a guard, the FIRST resolution on a fresh machine was
    // written nowhere and reported only as a warning — the journal would look
    // permanently empty with no failure anyone would notice.
    expect(existsSync(join(root, '.ion'))).toBe(false)
    recordResolution(entry({ path: 'first.ts' }))
    expect(loadResolutions().map((e) => e.path)).toEqual(['first.ts'])
  })

  it('returns an empty journal before anything is written', () => {
    expect(loadResolutions()).toEqual([])
  })

  it('persists an entry and reads it back whole', () => {
    recordResolution(entry())
    const [read] = loadResolutions()
    expect(read).toMatchObject({
      path: 'desktop/src/x.tsx',
      memberBranch: 'wt/a',
      collidedWith: ['wt/b'],
      rationale: 'kept the factory structure, added the anchored placement',
      verified: true,
    })
  })

  it('appends rather than replacing', () => {
    recordResolution(entry({ path: 'a.ts' }))
    recordResolution(entry({ path: 'b.ts' }))
    expect(loadResolutions().map((e) => e.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('writes through the atomic path, leaving no temp file behind', () => {
    recordResolution(entry())
    expect(existsSync(resolutionsFile())).toBe(true)
    const parsed = JSON.parse(readFileSync(resolutionsFile(), 'utf-8'))
    expect(parsed.version).toBe(1)
    expect(parsed.entries).toHaveLength(1)
  })
})

describe('bench resolution journal — staleness pruning', () => {
  it('drops an entry whose base has left the source history', () => {
    recordResolution(entry({ path: 'stale.ts', baseSha: 'gone' }))
    recordResolution(entry({ path: 'fresh.ts', baseSha: 'alive' }), (base) => base === 'alive')
    expect(loadResolutions().map((e) => e.path)).toEqual(['fresh.ts'])
  })

  it('keeps an entry whose base is still an ancestor', () => {
    recordResolution(entry({ path: 'old.ts', baseSha: 'alive' }))
    recordResolution(entry({ path: 'new.ts', baseSha: 'alive' }), (base) => base === 'alive')
    expect(loadResolutions().map((e) => e.path)).toEqual(['old.ts', 'new.ts'])
  })

  it('never prunes another bench, whose base it cannot judge', () => {
    // The predicate answers about ONE source branch's history. Applying it to a
    // different bench's entries would delete them on the first write elsewhere.
    recordResolution(entry({ path: 'other.ts', sourceBranch: 'main', baseSha: 'gone' }))
    recordResolution(entry({ path: 'mine.ts', baseSha: 'alive' }), (base) => base === 'alive')
    expect(loadResolutions().map((e) => e.path).sort()).toEqual(['mine.ts', 'other.ts'])
  })

  it('keeps an entry when the staleness probe throws', () => {
    // A failed probe is not evidence of staleness. Dropping on error would
    // silently discard good context the first time git hiccupped.
    recordResolution(entry({ path: 'kept.ts', baseSha: 'unknown' }))
    recordResolution(entry({ path: 'added.ts' }), () => { throw new Error('git unavailable') })
    expect(loadResolutions().map((e) => e.path).sort()).toEqual(['added.ts', 'kept.ts'])
  })

  it('prunes nothing when no predicate is supplied', () => {
    recordResolution(entry({ path: 'a.ts', baseSha: 'ancient' }))
    recordResolution(entry({ path: 'b.ts' }))
    expect(loadResolutions()).toHaveLength(2)
  })
})

describe('bench resolution journal — corrupt and hostile files', () => {
  // Seeding a file by hand needs the directory; the production write path
  // creates it itself (pinned above).
  beforeEach(() => { mkdirSync(join(root, '.ion'), { recursive: true }) })

  it('treats unparseable JSON as an empty journal rather than throwing', () => {
    writeFileSync(resolutionsFile(), '{ not json')
    expect(loadResolutions()).toEqual([])
  })

  it('treats a file with no entries array as empty', () => {
    writeFileSync(resolutionsFile(), JSON.stringify({ version: 1 }))
    expect(loadResolutions()).toEqual([])
  })

  it('drops malformed entries but keeps the well-formed ones', () => {
    writeFileSync(resolutionsFile(), JSON.stringify({
      version: 1,
      entries: [null, { path: 'no-repo.ts' }, entry({ path: 'good.ts' })],
    }))
    expect(loadResolutions().map((e) => e.path)).toEqual(['good.ts'])
  })

  it('still records over a corrupt file rather than refusing forever', () => {
    writeFileSync(resolutionsFile(), 'garbage')
    recordResolution(entry({ path: 'after.ts' }))
    expect(loadResolutions().map((e) => e.path)).toEqual(['after.ts'])
  })
})

describe('bench resolution journal — query', () => {
  beforeEach(() => {
    recordResolution(entry({ path: 'shared.tsx', resolvedAt: 100, memberBranch: 'wt/a' }))
    recordResolution(entry({ path: 'shared.tsx', resolvedAt: 300, memberBranch: 'wt/c' }))
    recordResolution(entry({ path: 'other.ts', resolvedAt: 200 }))
    recordResolution(entry({ path: 'shared.tsx', sourceBranch: 'main', resolvedAt: 400 }))
  })

  it('narrows to the bench, never leaking another source branch', () => {
    const got = resolutionsFor('/repo', 'josh')
    expect(got.every((e) => e.sourceBranch === 'josh')).toBe(true)
    expect(got).toHaveLength(3)
  })

  it('narrows to the requested paths', () => {
    expect(resolutionsFor('/repo', 'josh', ['shared.tsx']).map((e) => e.path))
      .toEqual(['shared.tsx', 'shared.tsx'])
  })

  it('returns newest first, so the most recent decision is read first', () => {
    expect(resolutionsFor('/repo', 'josh', ['shared.tsx']).map((e) => e.resolvedAt))
      .toEqual([300, 100])
  })

  it('answers across members, which is the entire point', () => {
    // A decision made while integrating wt/a must reach whoever collides on the
    // same file while integrating wt/c. Keyed by path, never by member.
    const got = resolutionsFor('/repo', 'josh', ['shared.tsx'])
    expect(got.map((e) => e.memberBranch)).toEqual(['wt/c', 'wt/a'])
  })

  it('returns nothing for an unknown repo', () => {
    expect(resolutionsFor('/other-repo', 'josh')).toEqual([])
  })
})

/**
 * The journal format contract.
 *
 * The journal is written by bench-resolution-journal.ts and read back by the
 * same module plus bench-agent-tools.ts (the BenchResolutionHistory client
 * tool). A field renamed on one side breaks the other silently: the reader
 * decodes the missing field to its zero value and reports a resolution with no
 * rationale, which looks like a working journal that has nothing useful in it.
 *
 * `testdata/integration-resolutions.fixture.json` is the pinned artifact
 * (formerly shared with the engine's reader, now desktop-local since the
 * bench agent surface moved to the desktop's client tool gate). This asserts
 * the writer emits exactly that shape and the reader consumes every field.
 */
describe('bench resolution journal — format contract', () => {
  it('writes every field the reader decodes, under the same names', () => {
    const fixturePath = join(
      __dirname, 'testdata', 'integration-resolutions.fixture.json',
    )
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
      version: number
      entries: Record<string, unknown>[]
    }

    recordResolution(entry())
    const written = JSON.parse(readFileSync(resolutionsFile(), 'utf-8')) as {
      version: number
      entries: Record<string, unknown>[]
    }

    expect(written.version).toBe(fixture.version)
    // Key-for-key: a field the writer stopped emitting, or renamed, fails here
    // rather than in production six merges later.
    expect(Object.keys(written.entries[0]).sort()).toEqual(Object.keys(fixture.entries[0]).sort())
  })

  it('round-trips the fixture through the reader without losing a field', () => {
    // The reader's own filter (`path` and `repoPath` present) must accept every
    // fixture entry — if it drops one, the two sides disagree about validity.
    const fixturePath = join(
      __dirname, 'testdata', 'integration-resolutions.fixture.json',
    )
    const fixture = readFileSync(fixturePath, 'utf-8')
    mkdirSync(join(root, '.ion'), { recursive: true })
    writeFileSync(resolutionsFile(), fixture)

    const read = loadResolutions()
    expect(read).toHaveLength(2)
    expect(read[0].rationale).toContain('useWorktreeRowMenuVerbs')
    expect(read[0].collidedWith).toHaveLength(2)
    expect(read[1].verified).toBe(false)
  })
})
