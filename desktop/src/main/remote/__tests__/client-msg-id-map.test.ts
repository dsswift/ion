import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordClientMsgId,
  lookupClientMsgId,
  clearClientMsgIdsForTab,
  __resetClientMsgIdMapForTest,
} from '../client-msg-id-map'

/**
 * client-msg-id-map — desktop-local clientMsgId ↔ canonical-entry-id map (RC-9).
 *
 * The engine persists no client id (UI concern); the desktop bridges the
 * optimistic bubble id iOS sent to the canonical entry id the engine reports, so
 * a history load can annotate the user row and iOS reconciles by the id it sent.
 */
describe('client-msg-id-map', () => {
  beforeEach(() => {
    __resetClientMsgIdMapForTest()
  })

  it('records and looks up a clientMsgId by canonical entry id', () => {
    recordClientMsgId('tab-1', 'entry-abc', 'client-xyz')
    expect(lookupClientMsgId('tab-1', 'entry-abc')).toBe('client-xyz')
  })

  it('scopes lookups per tab', () => {
    recordClientMsgId('tab-1', 'entry-1', 'client-1')
    expect(lookupClientMsgId('tab-2', 'entry-1')).toBeUndefined()
  })

  it('ignores desktop-minted fallback ids (nothing reconciles against them)', () => {
    recordClientMsgId('tab-1', 'entry-1', 'remote-12345')
    recordClientMsgId('tab-1', 'entry-2', 'remote-engine-999')
    expect(lookupClientMsgId('tab-1', 'entry-1')).toBeUndefined()
    expect(lookupClientMsgId('tab-1', 'entry-2')).toBeUndefined()
  })

  it('no-ops on empty inputs', () => {
    recordClientMsgId('', 'e', 'c')
    recordClientMsgId('tab-1', undefined, 'c')
    recordClientMsgId('tab-1', 'e', null)
    recordClientMsgId('tab-1', 'e', undefined)
    expect(lookupClientMsgId('tab-1', 'e')).toBeUndefined()
  })

  it('clears a tab on close', () => {
    recordClientMsgId('tab-1', 'entry-1', 'client-1')
    clearClientMsgIdsForTab('tab-1')
    expect(lookupClientMsgId('tab-1', 'entry-1')).toBeUndefined()
  })

  it('bounds growth per tab (LRU eviction past the cap)', () => {
    // Record well past the 200 cap; the oldest must be evicted, the newest kept.
    for (let i = 0; i < 250; i++) {
      recordClientMsgId('tab-1', `entry-${i}`, `client-${i}`)
    }
    // Oldest (entry-0) evicted.
    expect(lookupClientMsgId('tab-1', 'entry-0')).toBeUndefined()
    // Newest retained.
    expect(lookupClientMsgId('tab-1', 'entry-249')).toBe('client-249')
  })

  it('refreshes LRU position on re-record so a re-touched entry is not evicted early', () => {
    recordClientMsgId('tab-1', 'entry-keep', 'client-keep')
    // Re-record it later to move it to the front of the LRU.
    for (let i = 0; i < 100; i++) recordClientMsgId('tab-1', `entry-${i}`, `client-${i}`)
    recordClientMsgId('tab-1', 'entry-keep', 'client-keep') // refresh
    for (let i = 100; i < 250; i++) recordClientMsgId('tab-1', `entry-${i}`, `client-${i}`)
    // Despite 250 later records, the refreshed entry survives (it was re-touched
    // after the first 100, so it is newer than the evicted range).
    expect(lookupClientMsgId('tab-1', 'entry-keep')).toBe('client-keep')
  })
})
