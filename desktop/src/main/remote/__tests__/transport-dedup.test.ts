/**
 * transport-dedup.test.ts
 *
 * Regression coverage for the windowed inbound dedup (InboundDedup), which
 * replaced the strict "drop anything <= lastReceivedSeq" high-water mark in
 * RemoteTransport._handleIncoming.
 *
 * The strict mark silently ate real commands: iOS fires commands from
 * concurrent Tasks (wire order != seq order) and late frames arrive from the
 * old socket during relay→LAN transitions, so a burst of DISTINCT lower seqs
 * was dropped as "duplicates" (live logs: seq 147 dropped because last_seq
 * 192). Each accept-out-of-order test here fails against that behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

import { InboundDedup, DEDUP_WINDOW } from '../transport-dedup'
import { InboundEpochTracker } from '../transport-inbound-epoch'

const DEV = 'device-1'

describe('InboundDedup — windowed reorder-tolerant dedup', () => {
  let dedup: InboundDedup

  beforeEach(() => {
    dedup = new InboundDedup()
  })

  it('accepts out-of-order distinct seqs within the window exactly once', () => {
    // High seq arrives first (concurrent iOS Tasks), then the lower ones late.
    expect(dedup.shouldAccept(DEV, 5)).toBe(true)
    // Old strict-monotonic code dropped every one of these as "duplicates".
    expect(dedup.shouldAccept(DEV, 1)).toBe(true)
    expect(dedup.shouldAccept(DEV, 3)).toBe(true)
    expect(dedup.shouldAccept(DEV, 2)).toBe(true)
    expect(dedup.shouldAccept(DEV, 4)).toBe(true)
    // Exactly once: replays of already-accepted seqs are dropped.
    expect(dedup.shouldAccept(DEV, 3)).toBe(false)
    expect(dedup.shouldAccept(DEV, 5)).toBe(false)
  })

  it('reproduces the live-log burst: seq 147 after high-water 192 is accepted', () => {
    for (let s = 148; s <= 192; s++) dedup.shouldAccept(DEV, s)
    expect(dedup.shouldAccept(DEV, 147)).toBe(true)
    expect(dedup.shouldAccept(DEV, 147)).toBe(false) // now a genuine duplicate
  })

  it('drops a true duplicate of the high-water seq', () => {
    expect(dedup.shouldAccept(DEV, 1)).toBe(true)
    expect(dedup.shouldAccept(DEV, 1)).toBe(false)
  })

  it('drops seqs at or beyond the window edge', () => {
    expect(dedup.shouldAccept(DEV, 1000)).toBe(true)
    // Window is (highWater - DEDUP_WINDOW, highWater]: 1000 - 512 = 488 is out.
    expect(dedup.shouldAccept(DEV, 1000 - DEDUP_WINDOW)).toBe(false)
    // One inside the edge is in.
    expect(dedup.shouldAccept(DEV, 1000 - DEDUP_WINDOW + 1)).toBe(true)
  })

  it('epoch reset clears the high-water mark so the new epoch seq 1 is accepted', () => {
    // A stale high-seq frame from the previous epoch poisons the mark beyond
    // the window; without the reset, the fresh epoch's low seqs all drop.
    expect(dedup.shouldAccept(DEV, 1000)).toBe(true)
    dedup.reset(DEV)
    expect(dedup.shouldAccept(DEV, 1)).toBe(true)
    expect(dedup.shouldAccept(DEV, 2)).toBe(true)
  })

  it('epoch reset clears the seen-set (a reused seq is not a duplicate across epochs)', () => {
    expect(dedup.shouldAccept(DEV, 10)).toBe(true)
    expect(dedup.shouldAccept(DEV, 9)).toBe(true) // in seen-set
    dedup.reset(DEV)
    // iOS resets its outbound seq to 0 on LAN auth; the same numbers come again.
    expect(dedup.shouldAccept(DEV, 9)).toBe(true)
    expect(dedup.shouldAccept(DEV, 10)).toBe(true)
  })

  it('tracks devices independently', () => {
    expect(dedup.shouldAccept('dev-a', 1)).toBe(true)
    expect(dedup.shouldAccept('dev-b', 1)).toBe(true)
    expect(dedup.shouldAccept('dev-a', 1)).toBe(false)
    dedup.remove('dev-a')
    expect(dedup.shouldAccept('dev-a', 1)).toBe(true) // forgotten entirely
    expect(dedup.shouldAccept('dev-b', 1)).toBe(false) // untouched
  })

  it('prunes the seen-set as the high-water mark advances (stays bounded)', () => {
    // Drive far past the window; the set must not retain out-of-window seqs.
    for (let s = 1; s <= DEDUP_WINDOW * 3; s++) dedup.shouldAccept(DEV, s)
    // Everything at or below highWater - window is dropped as stale (whether or
    // not it was ever in the set), and the set no longer holds it.
    expect(dedup.shouldAccept(DEV, DEDUP_WINDOW)).toBe(false)
    // In-window replays are still detected as duplicates.
    expect(dedup.shouldAccept(DEV, DEDUP_WINDOW * 3 - 1)).toBe(false)
  })
})

describe('InboundEpochTracker — monotonic epoch verdicts', () => {
  let tracker: InboundEpochTracker

  beforeEach(() => {
    tracker = new InboundEpochTracker()
  })

  it('first-ever epoch adopts without a reset', () => {
    expect(tracker.check(DEV, 100, 1)).toBe('ok')
    expect(tracker.check(DEV, 100, 2)).toBe('ok')
  })

  it('a newer epoch yields exactly one reset, then equal epochs are ok', () => {
    tracker.check(DEV, 100, 1)
    expect(tracker.check(DEV, 200, 1)).toBe('reset')
    expect(tracker.check(DEV, 200, 2)).toBe('ok')
  })

  it('a stale epoch is dropped and never adopted (no flap on alternation)', () => {
    tracker.check(DEV, 100, 50)
    expect(tracker.check(DEV, 200, 1)).toBe('reset')
    // Straggler from the dead generation: stale, not adopted.
    expect(tracker.check(DEV, 100, 51)).toBe('stale')
    // The next new-generation frame must NOT reset again — the old
    // `!=`-style logic adopted the straggler and re-reset here.
    expect(tracker.check(DEV, 200, 2)).toBe('ok')
  })

  it('absent epoch is the legacy no-op path: never resets, never drops', () => {
    expect(tracker.check(DEV, undefined, 1)).toBe('ok')
    tracker.check(DEV, 100, 2)
    // Legacy frame after epoch-bearing ones (mid-upgrade window): still ok.
    expect(tracker.check(DEV, undefined, 3)).toBe('ok')
    // And it did not disturb the tracked epoch.
    expect(tracker.check(DEV, 100, 4)).toBe('ok')
    expect(tracker.check(DEV, 50, 5)).toBe('stale')
  })

  it('tracks devices independently and forgets on remove', () => {
    tracker.check('dev-a', 200, 1)
    tracker.check('dev-b', 100, 1)
    expect(tracker.check('dev-b', 150, 2)).toBe('reset') // b's own history
    tracker.remove('dev-a')
    // Forgotten: an "older" epoch is now first-seen for dev-a.
    expect(tracker.check('dev-a', 50, 1)).toBe('ok')
  })

  it('clear drops all state (transport stop)', () => {
    tracker.check(DEV, 200, 1)
    tracker.clear()
    expect(tracker.check(DEV, 100, 1)).toBe('ok')
  })
})
