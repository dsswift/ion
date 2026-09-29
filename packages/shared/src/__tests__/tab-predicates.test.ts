/**
 * tab-predicates — derived predicate unit tests.
 *
 * Verifies that `tabHasExtensions` and `persistedTabHasExtensions` produce
 * the same classification as the old stored `hasEngineExtension` boolean
 * across all tab fixture shapes: plain, engine, CLI, and legacy persisted.
 */

import { describe, it, expect } from 'vitest'
import { tabHasExtensions, persistedTabHasExtensions } from '../tab-predicates'

// ─── tabHasExtensions (runtime TabState) ──────────────────────────────────────

describe('tabHasExtensions', () => {
  it('returns true when engineProfileId is a non-empty string', () => {
    expect(tabHasExtensions({ engineProfileId: 'cos' })).toBe(true)
    expect(tabHasExtensions({ engineProfileId: 'test-profile' })).toBe(true)
    expect(tabHasExtensions({ engineProfileId: '__direct__' })).toBe(true)
  })

  it('returns false when engineProfileId is null (plain tab)', () => {
    expect(tabHasExtensions({ engineProfileId: null })).toBe(false)
  })

  it('returns false when engineProfileId is empty string', () => {
    expect(tabHasExtensions({ engineProfileId: '' })).toBe(false)
  })

  // ─── Parity with old hasEngineExtension boolean ──────────────────────────

  it('matches old hasEngineExtension=true for engine tab fixture', () => {
    // Old: { hasEngineExtension: true, engineProfileId: 'profile-1' }
    // New: tabHasExtensions checks engineProfileId only
    expect(tabHasExtensions({ engineProfileId: 'profile-1' })).toBe(true)
  })

  it('matches old hasEngineExtension=false for plain tab fixture', () => {
    // Old: { hasEngineExtension: false, engineProfileId: null }
    expect(tabHasExtensions({ engineProfileId: null })).toBe(false)
  })

  it('matches old hasEngineExtension=false for CLI tab fixture', () => {
    // Old: { hasEngineExtension: false, engineProfileId: null }
    expect(tabHasExtensions({ engineProfileId: null })).toBe(false)
  })
})

// ─── persistedTabHasExtensions (persisted PersistedTabState) ──────────────────

describe('persistedTabHasExtensions', () => {
  it('returns true when engineProfileId is set (new format)', () => {
    expect(persistedTabHasExtensions({ engineProfileId: 'cos' })).toBe(true)
  })

  it('returns false when both fields are absent (plain tab)', () => {
    expect(persistedTabHasExtensions({})).toBe(false)
  })

  it('returns false when engineProfileId is null and hasEngineExtension is false', () => {
    expect(persistedTabHasExtensions({ engineProfileId: null, hasEngineExtension: false })).toBe(false)
  })

  it('falls back to legacy hasEngineExtension when engineProfileId is absent', () => {
    // Pre-Phase 4 persisted tabs: only hasEngineExtension exists, no engineProfileId
    expect(persistedTabHasExtensions({ hasEngineExtension: true })).toBe(true)
    expect(persistedTabHasExtensions({ hasEngineExtension: false })).toBe(false)
  })

  it('prefers engineProfileId over legacy hasEngineExtension', () => {
    // If both are present, engineProfileId wins
    expect(persistedTabHasExtensions({ engineProfileId: 'cos', hasEngineExtension: false })).toBe(true)
  })

  it('returns false when engineProfileId is empty string', () => {
    expect(persistedTabHasExtensions({ engineProfileId: '' })).toBe(false)
  })

  it('returns false when engineProfileId is empty and hasEngineExtension is false', () => {
    expect(persistedTabHasExtensions({ engineProfileId: '', hasEngineExtension: false })).toBe(false)
  })
})
