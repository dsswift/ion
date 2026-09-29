/**
 * session-ledger — the data-model encoding of the session-cut invariant.
 *
 * These pin the behaviour that makes restart-fragmentation structurally
 * impossible: only an explicit checkpoint (appendCut) grows a ledger, restart
 * resolves currentSessionId and appends nothing, and legacy conversationIds[]
 * chains migrate into the ledger with reason `unknown`.
 */
import { describe, it, expect } from 'vitest'
import { deriveLedger, resolveCurrentSessionId, appendCut, ledgerIds } from '../session-ledger'

describe('deriveLedger', () => {
  it('returns an existing ledger as-is (post-migration file)', () => {
    const sessions = [{ id: 'a', reason: 'clear' as const, createdAt: 5 }]
    expect(deriveLedger({ sessions })).toBe(sessions)
  })

  it('migrates a legacy conversationIds chain to reason "unknown", oldest first', () => {
    const ledger = deriveLedger({ conversationIds: ['c1', 'c2', 'c3'] })
    expect(ledger).toEqual([
      { id: 'c1', reason: 'unknown', createdAt: 0 },
      { id: 'c2', reason: 'unknown', createdAt: 0 },
      { id: 'c3', reason: 'unknown', createdAt: 0 },
    ])
  })

  it('returns [] for an empty instance', () => {
    expect(deriveLedger({})).toEqual([])
    expect(deriveLedger({ conversationIds: [] })).toEqual([])
  })
})

describe('resolveCurrentSessionId', () => {
  it('prefers explicit currentSessionId', () => {
    const inst = { currentSessionId: 'live', conversationIds: ['old'] }
    expect(resolveCurrentSessionId(inst)).toBe('live')
  })

  it('falls back to the newest ledger entry', () => {
    const inst = { sessions: [
      { id: 'older', reason: 'unknown' as const, createdAt: 0 },
      { id: 'newest', reason: 'clear' as const, createdAt: 1 },
    ] }
    expect(resolveCurrentSessionId(inst)).toBe('newest')
  })

  it('falls back to the newest migrated conversationId', () => {
    expect(resolveCurrentSessionId({ conversationIds: ['a', 'b'] })).toBe('b')
  })

  it('uses the provided fallback when nothing is resolvable', () => {
    expect(resolveCurrentSessionId({}, 'last-known')).toBe('last-known')
    expect(resolveCurrentSessionId({})).toBe('')
  })
})

describe('appendCut — the ONLY ledger-growth path', () => {
  it('appends a checkpoint entry with parentId = prior current id', () => {
    const ledger = [{ id: 'first', reason: 'unknown' as const, createdAt: 0 }]
    const next = appendCut(ledger, 'second', 'clear', 100)
    expect(next).toEqual([
      { id: 'first', reason: 'unknown', createdAt: 0 },
      { id: 'second', reason: 'clear', createdAt: 100, parentId: 'first' },
    ])
    // Immutable: original ledger untouched.
    expect(ledger).toHaveLength(1)
  })

  it('omits parentId on the first cut of an empty ledger', () => {
    const next = appendCut([], 'first', 'clear', 50)
    expect(next).toEqual([{ id: 'first', reason: 'clear', createdAt: 50 }])
    expect(next[0]).not.toHaveProperty('parentId')
  })

  it('is idempotent: re-cutting the same newest id does not grow the ledger', () => {
    const ledger = [{ id: 'x', reason: 'clear' as const, createdAt: 1 }]
    expect(appendCut(ledger, 'x', 'clear', 2)).toBe(ledger)
  })
})

describe('ledgerIds', () => {
  it('flattens to the ordered id list', () => {
    const ledger = [
      { id: 'a', reason: 'unknown' as const, createdAt: 0 },
      { id: 'b', reason: 'clear' as const, createdAt: 1 },
    ]
    expect(ledgerIds(ledger)).toEqual(['a', 'b'])
  })
})

describe('restart-fragmentation invariant (the headline guarantee)', () => {
  it('resolving the current id then restoring appends NOTHING to the ledger', () => {
    // Simulate the affected tab: a 3-id chain migrated to the ledger.
    const inst = { conversationIds: [
      '1782534854978-fbad527c6268',
      '1782566209276-9d31cb15c325',
      '1782567882178-adec70d47051',
    ] }
    const ledger = deriveLedger(inst)
    const current = resolveCurrentSessionId({ sessions: ledger })

    // Restore resumes the current id — it must NOT call appendCut.
    expect(current).toBe('1782567882178-adec70d47051')
    // The ledger the next save persists is identical — no 4th entry minted.
    expect(deriveLedger({ sessions: ledger })).toHaveLength(3)
  })
})
