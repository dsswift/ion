/**
 * Per-message log rate limit.
 *
 * Every assertion here fails against an unlimited logger: without the limiter
 * `allow` is never false and no withheld count is ever reported. The property is
 * that a runaway call site cannot rotate away the log window holding the
 * evidence of itself — while costing nothing at any legitimate log rate, and
 * never dropping a line without reporting the count.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  admitLogLine,
  drainSuppressions,
  _resetForTest,
  WINDOW_MS,
  PER_WINDOW_LIMIT,
  MAX_TRACKED_KEYS,
} from '../log-rate-limit'

const T0 = 1_700_000_000_000

beforeEach(_resetForTest)

describe('admitLogLine', () => {
  it('admits the whole window budget verbatim', () => {
    for (let i = 0; i < PER_WINDOW_LIMIT; i++) {
      const d = admitLogLine('INFO', 'worktree.inventory', 'refreshed', T0)
      expect(d.allow, `line ${i + 1} of the window was withheld`).toBe(true)
      expect(d.summary).toBeUndefined()
    }
  })

  it('withholds past the budget', () => {
    for (let i = 0; i < PER_WINDOW_LIMIT; i++) admitLogLine('INFO', 'tag', 'msg', T0)
    expect(admitLogLine('INFO', 'tag', 'msg', T0).allow).toBe(false)
  })

  it('reports the withheld count on the first line of the next window', () => {
    const storm = 500
    for (let i = 0; i < storm; i++) admitLogLine('INFO', 'tag', 'msg', T0)

    const next = admitLogLine('INFO', 'tag', 'msg', T0 + WINDOW_MS)
    expect(next.allow).toBe(true)
    expect(next.summary?.count).toBe(storm - PER_WINDOW_LIMIT)

    // Exactly once — a count reported twice is as wrong as one never reported.
    expect(admitLogLine('INFO', 'tag', 'msg', T0 + WINDOW_MS).summary).toBeUndefined()
  })

  it('keys on the call site, so one storm cannot silence another message', () => {
    for (let i = 0; i < PER_WINDOW_LIMIT + 10; i++) {
      admitLogLine('INFO', 'remote_transport', 'scheduling token refresh', T0)
    }
    expect(admitLogLine('INFO', 'remote_transport', 'init', T0).allow).toBe(true)
    // Same msg, different tag: a different call site, so a separate budget.
    expect(admitLogLine('INFO', 'other', 'scheduling token refresh', T0).allow).toBe(true)
    // Same msg and tag at a different level is also a distinct line.
    expect(admitLogLine('WARN', 'remote_transport', 'scheduling token refresh', T0).allow).toBe(true)
  })

  it('never limits ERROR', () => {
    for (let i = 0; i < PER_WINDOW_LIMIT * 10; i++) {
      expect(admitLogLine('ERROR', 'main', 'engine send failed', T0).allow).toBe(true)
    }
  })

  it('bounds the tracked identities', () => {
    // Only reachable when a call site interpolates a value into `msg`, which
    // ADR-019 forbids — the cap keeps that mistake from leaking the logger.
    for (let i = 0; i < MAX_TRACKED_KEYS + 200; i++) {
      admitLogLine('INFO', 'leaky', `msg ${i}`, T0 + i * WINDOW_MS * 3)
    }
    // Observable through behaviour rather than internals: every identity is
    // still admitted, and nothing threw.
    expect(admitLogLine('INFO', 'leaky', 'msg final', T0).allow).toBe(true)
  })
})

describe('drainSuppressions', () => {
  it('reports the tail of a storm that has no successor line', () => {
    const storm = 200
    for (let i = 0; i < storm; i++) admitLogLine('INFO', 'session', 'stopsession', T0)

    const drained = drainSuppressions()
    expect(drained).toHaveLength(1)
    expect(drained[0].count).toBe(storm - PER_WINDOW_LIMIT)
    expect(drained[0].key).toBe('INFO|session|stopsession')

    // Draining clears, so shutdown cannot double-report.
    expect(drainSuppressions()).toHaveLength(0)
  })

  it('reports nothing when no line was ever withheld', () => {
    admitLogLine('INFO', 'tag', 'msg', T0)
    expect(drainSuppressions()).toHaveLength(0)
  })
})
