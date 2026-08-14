/**
 * worktree-list — the join between the worktree inventory and bench membership.
 *
 * The behaviour that matters: ONE worktree yields ONE row whether or not it is
 * enrolled. Before the join existed, an enrolled worktree appeared twice in the
 * git panel -- once in the Worktrees section and once in the Integration
 * section -- with two different vocabularies describing the same directory.
 */
import { describe, it, expect } from 'vitest'
import { buildWorktreeList, findMembership } from '../worktree-list'
import type {
  WorktreeInventoryEntry, IntegrationWorkspace, IntegrationMember,
} from '../types-git'

const REPO = '/repo'

function entry(over: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  return {
    worktreePath: '/wt/a',
    branchName: 'wt/a',
    label: 'a',
    title: undefined,
    sourceBranch: 'josh',
    head: 'aaa1111',
    lastCommitSubject: 'feat: a',
    isDirty: false,
    unlandedCommitCount: 0,
    needsSync: false,
    safeToDiscard: false,
    ...over,
  }
}

function member(over: Partial<IntegrationMember> = {}): IntegrationMember {
  return {
    worktreePath: '/wt/a',
    branchName: 'wt/a',
    enabled: true,
    pin: 'current',
    merge: 'merged',
    pinnedSha: 'aaa1111',
    pinnedTreeHash: 'tree-a',
    pinnedBaseSha: 'base-a',
    currentTreeHash: 'tree-a',
    ...over,
  }
}

function workspace(members: IntegrationMember[], sourceBranch = 'josh'): IntegrationWorkspace {
  return {
    repoPath: REPO,
    sourceBranch,
    benchPath: `/bench/${sourceBranch}`,
    benchBranch: `ion/bench/${sourceBranch}`,
    members,
    baseSha: 'base',
    lastBuiltAt: 0,
  }
}

describe('buildWorktreeList — one worktree, one row', () => {
  it('decorates an enrolled worktree instead of duplicating it', () => {
    const entries = [entry({ worktreePath: '/wt/a' }), entry({ worktreePath: '/wt/b', branchName: 'wt/b' })]
    const ws = workspace([member({ worktreePath: '/wt/a' })])

    const { items } = buildWorktreeList(entries, [ws], 'josh')

    expect(items).toHaveLength(2)
    expect(items.filter((i) => i.entry.worktreePath === '/wt/a')).toHaveLength(1)
    expect(items[0].membership).toBeDefined()
    expect(items[0].enrollment).toBe('included')
  })

  it('reports an unenrolled worktree as `none` with no membership', () => {
    const { items } = buildWorktreeList([entry()], [], null)
    expect(items[0].enrollment).toBe('none')
    expect(items[0].membership).toBeUndefined()
    expect(items[0].order).toBeUndefined()
  })

  it('distinguishes excluded from unenrolled', () => {
    // Two different facts the old model could not tell apart on a row: `none`
    // means "not in the bench", `excluded` means "in the bench, skipped".
    const ws = workspace([member({ enabled: false })])
    const { items } = buildWorktreeList([entry()], [ws], 'josh')
    expect(items[0].enrollment).toBe('excluded')
    expect(items[0].membership).toBeDefined()
  })

  it('supplies the worktree title to an enrolled row', () => {
    // RED before the sidecar: IntegrationMember had no `title`, so a bench row
    // could not show the human name the worktree row already showed.
    const ws = workspace([member()])
    const { items } = buildWorktreeList([entry({ title: 'Fix the thing' })], [ws], 'josh')
    expect(items[0].entry.title).toBe('Fix the thing')
    expect(items[0].membership).toBeDefined()
  })
})

describe('buildWorktreeList — order', () => {
  it('numbers enrolled rows by merge position, 1-based', () => {
    const entries = [
      entry({ worktreePath: '/wt/a', branchName: 'wt/a' }),
      entry({ worktreePath: '/wt/b', branchName: 'wt/b' }),
      entry({ worktreePath: '/wt/c', branchName: 'wt/c' }),
    ]
    const ws = workspace([
      member({ worktreePath: '/wt/c', branchName: 'wt/c' }),
      member({ worktreePath: '/wt/a', branchName: 'wt/a' }),
    ])

    const { items } = buildWorktreeList(entries, [ws], 'josh')

    // Array position in the workspace IS merge order, so /wt/c is first.
    expect(items.map((i) => [i.entry.worktreePath, i.order])).toEqual([
      ['/wt/c', 1],
      ['/wt/a', 2],
      ['/wt/b', undefined],
    ])
  })

  it('sorts every enrolled row ahead of every unenrolled one', () => {
    const entries = [
      entry({ worktreePath: '/wt/x', branchName: 'wt/x' }),
      entry({ worktreePath: '/wt/y', branchName: 'wt/y' }),
      entry({ worktreePath: '/wt/z', branchName: 'wt/z' }),
    ]
    const ws = workspace([member({ worktreePath: '/wt/z', branchName: 'wt/z' })])

    const { items } = buildWorktreeList(entries, [ws], 'josh')

    expect(items[0].entry.worktreePath).toBe('/wt/z')
    expect(items.slice(1).every((i) => i.order === undefined)).toBe(true)
  })

  it('keeps the inventory order among unenrolled rows', () => {
    const entries = [
      entry({ worktreePath: '/wt/1', branchName: 'wt/1' }),
      entry({ worktreePath: '/wt/2', branchName: 'wt/2' }),
    ]
    const { items } = buildWorktreeList(entries, [], null)
    expect(items.map((i) => i.entry.worktreePath)).toEqual(['/wt/1', '/wt/2'])
  })
})

describe('buildWorktreeList — landed work sinks to its own band', () => {
  const LANDED_AT = 1_700_000_000_000

  it('marks a worktree whose work actually landed', () => {
    const { items } = buildWorktreeList(
      [entry({ landedAt: LANDED_AT, unlandedCommitCount: 0, safeToDiscard: true })], [], null)
    expect(items[0].landed).toBe(true)
  })

  // THE case this definition exists for. A brand-new worktree has committed
  // nothing, so it is clean with zero unlanded commits -- identical to a landed
  // one by every git measure. Sorting on `safeToDiscard` filed it under Landed,
  // claiming work had shipped when none was ever done.
  it('does NOT mark a fresh worktree that has never committed anything', () => {
    const { items } = buildWorktreeList(
      [entry({ landedAt: undefined, unlandedCommitCount: 0, safeToDiscard: true })], [], null)
    expect(items[0].landed).toBe(false)
  })

  it('does not mark a worktree that still holds unlanded work', () => {
    const { items } = buildWorktreeList([entry({ unlandedCommitCount: 2 })], [], null)
    expect(items[0].landed).toBe(false)
  })

  it('keeps a worktree landed after later branch movement', () => {
    // `landedAt` is the durable witness of a successful terminal Land. A later
    // commit cannot turn this checkout into active work again: it stays sealed
    // until the operator explicitly retires it.
    const { items } = buildWorktreeList(
      [entry({ landedAt: LANDED_AT, unlandedCommitCount: 3 })], [], null)
    expect(items[0].landed).toBe(true)
  })

  it('sorts landed worktrees below active ones', () => {
    const entries = [
      entry({ worktreePath: '/wt/done', branchName: 'wt/done', landedAt: LANDED_AT, safeToDiscard: true }),
      entry({ worktreePath: '/wt/active', branchName: 'wt/active', unlandedCommitCount: 1 }),
    ]

    const { items } = buildWorktreeList(entries, [], null)

    expect(items.map((i) => i.entry.worktreePath)).toEqual(['/wt/active', '/wt/done'])
  })

  it('leaves a fresh empty worktree in the active band, above landed ones', () => {
    const entries = [
      entry({ worktreePath: '/wt/done', branchName: 'wt/done', landedAt: LANDED_AT, safeToDiscard: true }),
      entry({ worktreePath: '/wt/fresh', branchName: 'wt/fresh', safeToDiscard: true }),
    ]

    const { items } = buildWorktreeList(entries, [], null)

    expect(items.map((i) => i.entry.worktreePath)).toEqual(['/wt/fresh', '/wt/done'])
  })

  // Reverses an earlier rule, deliberately. It read "a bench member has a live
  // obligation -- its pin -- whatever its own landing state", which holds only
  // while the pin carries UNLANDED work. Once the work is in the source branch
  // the bench takes that content from its base, so the pin is a duplicate, not
  // an obligation -- and `bench-contribution.isLandedIntoSource` already retires such
  // a member and marks its pin `absorbed`. The old rule contradicted the bench's
  // own model and stranded a finished worktree at the top of the list.
  it('sinks an enrolled worktree once its work has landed', () => {
    const ws = workspace([member({ worktreePath: '/wt/a' })])
    const entries = [
      entry({ worktreePath: '/wt/a', landedAt: LANDED_AT, safeToDiscard: true }),
      entry({ worktreePath: '/wt/b', branchName: 'wt/b', unlandedCommitCount: 1 }),
    ]

    const { items } = buildWorktreeList(entries, [ws], 'josh')

    expect(items.map((i) => i.entry.worktreePath)).toEqual(['/wt/b', '/wt/a'])
    expect(items.find((i) => i.entry.worktreePath === '/wt/a')!.landed).toBe(true)
  })

  it('keeps an enrolled worktree ABOVE active work while its pin still holds work', () => {
    // The case the old rule was reaching for, and the one that still holds: a
    // member with unlanded commits is a live obligation and leads the list.
    const ws = workspace([member({ worktreePath: '/wt/a' })])
    const entries = [
      entry({ worktreePath: '/wt/b', branchName: 'wt/b', unlandedCommitCount: 1 }),
      entry({ worktreePath: '/wt/a', unlandedCommitCount: 3 }),
    ]

    const { items } = buildWorktreeList(entries, [ws], 'josh')

    expect(items[0].entry.worktreePath).toBe('/wt/a')
    expect(items[0].landed).toBe(false)
  })

  it('sinks the exact shape the land verb leaves behind', () => {
    // Reported live: Land ran, `landedAt` was written, unlanded went to 0 -- and
    // the row stayed at the top of the list because it was still an enabled
    // member with a `current` pin and a `merged` state. The bench had not
    // rebuilt yet, so nothing had retired the membership.
    const ws = workspace([
      member({ worktreePath: '/wt/other', branchName: 'wt/other' }),
      member({ worktreePath: '/wt/a', enabled: true, pin: 'current', merge: 'merged' }),
    ])
    const entries = [
      entry({ worktreePath: '/wt/a', landedAt: LANDED_AT, unlandedCommitCount: 0, safeToDiscard: true }),
      entry({ worktreePath: '/wt/other', branchName: 'wt/other', unlandedCommitCount: 2 }),
    ]

    const { items } = buildWorktreeList(entries, [ws], 'josh')

    expect(items.map((i) => i.entry.worktreePath)).toEqual(['/wt/other', '/wt/a'])
    expect(items.find((i) => i.entry.worktreePath === '/wt/a')!.landed).toBe(true)
  })

  it('sinks a member the bench has already absorbed', () => {
    // Same state one rebuild later: the pin reads `absorbed`. It must not
    // reappear in the active band on the strength of still being enrolled.
    const ws = workspace([member({ worktreePath: '/wt/a', pin: 'absorbed' })])
    const entries = [
      entry({ worktreePath: '/wt/a', landedAt: LANDED_AT, safeToDiscard: true }),
      entry({ worktreePath: '/wt/b', branchName: 'wt/b', unlandedCommitCount: 1 }),
    ]

    const { items } = buildWorktreeList(entries, [ws], 'josh')

    expect(items.map((i) => i.entry.worktreePath)).toEqual(['/wt/b', '/wt/a'])
  })

  it('keeps enrolled first, then active, then landed', () => {
    const ws = workspace([member({ worktreePath: '/wt/m', branchName: 'wt/m' })])
    const entries = [
      entry({ worktreePath: '/wt/done', branchName: 'wt/done', landedAt: LANDED_AT, safeToDiscard: true }),
      entry({ worktreePath: '/wt/active', branchName: 'wt/active', unlandedCommitCount: 1 }),
      entry({ worktreePath: '/wt/m', branchName: 'wt/m' }),
    ]

    const { items } = buildWorktreeList(entries, [ws], 'josh')

    expect(items.map((i) => i.entry.worktreePath))
      .toEqual(['/wt/m', '/wt/active', '/wt/done'])
  })

  it('preserves inventory order within the landed band', () => {
    const entries = [
      entry({ worktreePath: '/wt/d1', branchName: 'wt/d1', landedAt: LANDED_AT, safeToDiscard: true }),
      entry({ worktreePath: '/wt/d2', branchName: 'wt/d2', landedAt: LANDED_AT + 1, safeToDiscard: true }),
    ]

    const { items } = buildWorktreeList(entries, [], null)

    expect(items.map((i) => i.entry.worktreePath)).toEqual(['/wt/d1', '/wt/d2'])
  })
})

describe('buildWorktreeList — benches and orphans', () => {
  it('decorates rows from the ACTIVE bench only', () => {
    // A repo integrating into two branches has two benches; a row can show one
    // membership, so the caller picks which.
    const wsJosh = workspace([member()], 'josh')
    const wsMain = workspace([member({ enabled: false })], 'main')

    const asJosh = buildWorktreeList([entry()], [wsJosh, wsMain], 'josh')
    const asMain = buildWorktreeList([entry()], [wsJosh, wsMain], 'main')

    expect(asJosh.items[0].enrollment).toBe('included')
    expect(asMain.items[0].enrollment).toBe('excluded')
  })

  it('returns a membership with no worktree as an orphan, never as a row', () => {
    // An absorbed or retired member has no directory to open. A row would offer
    // verbs that cannot run.
    const ws = workspace([
      member({ worktreePath: '/wt/a' }),
      member({ worktreePath: '/wt/gone', branchName: 'wt/gone', pin: 'absorbed' }),
    ])

    const { items, orphans } = buildWorktreeList([entry({ worktreePath: '/wt/a' })], [ws], 'josh')

    expect(items).toHaveLength(1)
    expect(orphans).toHaveLength(1)
    expect(orphans[0].membership.worktreePath).toBe('/wt/gone')
    expect(orphans[0].sourceBranch).toBe('josh')
  })

  it('treats a repo with no bench as a plain list rather than an error', () => {
    const { items, orphans } = buildWorktreeList([entry()], [], 'josh')
    expect(items).toHaveLength(1)
    expect(items[0].enrollment).toBe('none')
    expect(orphans).toEqual([])
  })
})

describe('findMembership', () => {
  it('finds a worktree membership across every bench in the repo', () => {
    const wsJosh = workspace([member({ worktreePath: '/wt/a' })], 'josh')
    const wsMain = workspace([member({ worktreePath: '/wt/b', branchName: 'wt/b' })], 'main')

    expect(findMembership([wsJosh, wsMain], '/wt/b')?.sourceBranch).toBe('main')
    expect(findMembership([wsJosh, wsMain], '/wt/none')).toBeUndefined()
  })
})

/**
 * The active-worktree mark: "which checkout is the current conversation in?"
 *
 * Derived in this builder rather than in a component so the overlay panel, the
 * ATV mirror, and the wire projection cannot disagree about which row is
 * current — the same reason membership and order are joined here.
 */
describe('buildWorktreeList — active worktree', () => {
  const two = [entry({ worktreePath: '/wt/a', branchName: 'wt/a', label: 'a' }),
    entry({ worktreePath: '/wt/b', branchName: 'wt/b', label: 'b' })]

  it('marks the worktree whose path is the active directory', () => {
    const { items } = buildWorktreeList(two, [], null, '/wt/b')
    expect(items.find((i) => i.entry.worktreePath === '/wt/b')?.active).toBe(true)
  })

  it('marks no more than one row', () => {
    const { items } = buildWorktreeList(two, [], null, '/wt/b')
    expect(items.filter((i) => i.active)).toHaveLength(1)
  })

  it('marks a sibling as inactive rather than leaving it undefined', () => {
    const { items } = buildWorktreeList(two, [], null, '/wt/b')
    // Explicitly false, not undefined: a renderer reading `item.active` must
    // get a definite answer for every row.
    expect(items.find((i) => i.entry.worktreePath === '/wt/a')?.active).toBe(false)
  })

  it('marks nothing when the active conversation is elsewhere', () => {
    // A bench directory, the main clone, or an unrelated project. The bench has
    // its own bar, so no worktree row should claim the operator is in it.
    for (const elsewhere of ['/Users/x/.ion/integration/ion-josh', '/repo', '/somewhere/else']) {
      const { items } = buildWorktreeList(two, [], null, elsewhere)
      expect(items.some((i) => i.active)).toBe(false)
    }
  })

  it('marks nothing when there is no active directory', () => {
    for (const none of [null, undefined, '']) {
      const { items } = buildWorktreeList(two, [], null, none)
      expect(items.some((i) => i.active)).toBe(false)
    }
  })

  it('never marks a worktree whose path merely prefixes the active one', () => {
    // `ion-a3372546` vs `ion-a33725460`: a prefix test would highlight the
    // wrong checkout, which is worse than highlighting none.
    const prefixed = [
      entry({ worktreePath: '/wt/ion-a3372546', branchName: 'wt/short', label: 'short' }),
      entry({ worktreePath: '/wt/ion-a33725460', branchName: 'wt/long', label: 'long' }),
    ]
    const { items } = buildWorktreeList(prefixed, [], null, '/wt/ion-a33725460')
    expect(items.find((i) => i.entry.branchName === 'wt/long')?.active).toBe(true)
    expect(items.find((i) => i.entry.branchName === 'wt/short')?.active).toBe(false)
  })
})
