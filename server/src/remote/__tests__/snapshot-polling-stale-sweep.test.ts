import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { on: vi.fn(), handle: vi.fn() } }))

import { pickStaleKeysForQuery, STALE_STATUS_THRESHOLD_MS } from '../snapshot-polling'

/**
 * Phase 2 of the state-management overhaul. The stale-sweep helper
 * decides which engine session keys need a `query_session_status`
 * RPC because they have not received an `engine_status` event
 * recently enough to be considered fresh.
 *
 * These tests pin the inclusion rules:
 *   - never-seen keys (no entry in lastEngineStatusAt) ARE stale
 *   - keys seen within the threshold are NOT stale
 *   - keys seen older than the threshold ARE stale (with a strict
 *     >= threshold comparison so the boundary case is deterministic)
 *
 * The full sweep that calls sendQuerySessionStatus is exercised by
 * the end-to-end test in engine/internal/session/manager_heartbeat_test.go.
 */

describe('pickStaleKeysForQuery', () => {
  it('returns keys that have never received an engine_status event', () => {
    const now = 10_000
    const lastSeen = new Map<string, number>()
    const stale = pickStaleKeysForQuery(['tab-a', 'tab-b:inst-1'], lastSeen, now)
    expect(stale.sort()).toEqual(['tab-a', 'tab-b:inst-1'])
  })

  it('omits keys seen within the staleness threshold', () => {
    const now = 100_000
    const lastSeen = new Map<string, number>([
      ['fresh-tab', now - 5_000], // 5 s ago — fresh
    ])
    const stale = pickStaleKeysForQuery(['fresh-tab'], lastSeen, now)
    expect(stale).toEqual([])
  })

  it('includes keys seen older than the staleness threshold', () => {
    const now = 1_000_000
    const lastSeen = new Map<string, number>([
      ['stale-tab', now - STALE_STATUS_THRESHOLD_MS - 1], // just past threshold
    ])
    const stale = pickStaleKeysForQuery(['stale-tab'], lastSeen, now)
    expect(stale).toEqual(['stale-tab'])
  })

  it('uses a >= comparison so the boundary case is treated as stale', () => {
    // The Ion Operations failure was specifically a key that had not
    // received a status event for "a while" — making the boundary
    // inclusive avoids a one-tick jitter window where the desktop
    // would skip the query and wait another five seconds.
    const now = 1_000_000
    const lastSeen = new Map<string, number>([
      ['boundary-tab', now - STALE_STATUS_THRESHOLD_MS],
    ])
    const stale = pickStaleKeysForQuery(['boundary-tab'], lastSeen, now)
    expect(stale).toEqual(['boundary-tab'])
  })

  it('returns a mix of stale and fresh correctly partitioned', () => {
    const now = 5_000_000
    const lastSeen = new Map<string, number>([
      ['fresh-1', now - 1_000],
      ['stale-1', now - STALE_STATUS_THRESHOLD_MS - 10_000],
      ['fresh-2', now - 30_000],
      // 'never-seen' deliberately omitted
    ])
    const stale = pickStaleKeysForQuery(
      ['fresh-1', 'stale-1', 'fresh-2', 'never-seen'],
      lastSeen,
      now,
    )
    expect(stale.sort()).toEqual(['never-seen', 'stale-1'])
  })

  it('accepts a custom thresholdMs override', () => {
    const now = 10_000
    const lastSeen = new Map<string, number>([
      ['borderline', now - 2_000], // 2 s ago
    ])
    // With a 1 s threshold, borderline is stale; with 5 s, it is fresh.
    expect(pickStaleKeysForQuery(['borderline'], lastSeen, now, 1_000)).toEqual(['borderline'])
    expect(pickStaleKeysForQuery(['borderline'], lastSeen, now, 5_000)).toEqual([])
  })
})
