/**
 * Model Display Label Normalization Tests
 *
 * Tests for getModelDisplayLabel which converts raw model IDs
 * (e.g. 'claude-opus-4-6[1m]') into human-readable display labels.
 *
 * Related spec: specs/issue-coda-4-model-display-label-normalization.tests.md
 */

import { describe, it, expect } from 'vitest'
import { getModelDisplayLabel } from '../stores/model-labels'

// ─── TC-001: Known models without context hints ───

describe('TC-001: known models without context hints', () => {
  it('returns "Opus 4.6" for claude-opus-4-6', () => {
    expect(getModelDisplayLabel('claude-opus-4-6')).toBe('Opus 4.6')
  })

  it('returns "Sonnet 4.6" for claude-sonnet-4-6', () => {
    expect(getModelDisplayLabel('claude-sonnet-4-6')).toBe('Sonnet 4.6')
  })

  it('returns "Haiku 4.5" for claude-haiku-4-5-20251001', () => {
    expect(getModelDisplayLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  })
})

// ─── TC-002: Known models with [1m] context hint ───

describe('TC-002: known models with [1m] context hint', () => {
  it('returns "Opus 4.6 (1M)" for claude-opus-4-6[1m]', () => {
    expect(getModelDisplayLabel('claude-opus-4-6[1m]')).toBe('Opus 4.6 (1M)')
  })

  it('returns "Sonnet 4.6 (1M)" for claude-sonnet-4-6[1m]', () => {
    expect(getModelDisplayLabel('claude-sonnet-4-6[1m]')).toBe('Sonnet 4.6 (1M)')
  })
})

// ─── TC-003: Case-insensitive and whitespace-tolerant [1m] detection ───

describe('TC-003: case-insensitive and whitespace-tolerant [1m] detection', () => {
  it('handles uppercase [1M]', () => {
    expect(getModelDisplayLabel('claude-opus-4-6[1M]')).toBe('Opus 4.6 (1M)')
  })

  it('handles whitespace inside brackets [ 1m ]', () => {
    expect(getModelDisplayLabel('claude-opus-4-6[ 1m ]')).toBe('Opus 4.6 (1M)')
  })
})

// ─── TC-004: Unknown model with standard claude naming ───

describe('TC-004: unknown model with standard claude naming', () => {
  it('returns "Future 5.0" for claude-future-5-0', () => {
    expect(getModelDisplayLabel('claude-future-5-0')).toBe('Future 5.0')
  })

  it('returns "Future 5.0 (1M)" for claude-future-5-0[1m]', () => {
    expect(getModelDisplayLabel('claude-future-5-0[1m]')).toBe('Future 5.0 (1M)')
  })
})

// ─── TC-005: Non-standard model IDs ───

describe('TC-005: non-standard model IDs', () => {
  it('returns raw ID for completely unknown model', () => {
    expect(getModelDisplayLabel('some-unknown-model')).toBe('some-unknown-model')
  })

  it('returns raw ID with (1M) suffix for unknown model with hint', () => {
    expect(getModelDisplayLabel('some-unknown-model[1m]')).toBe('some-unknown-model (1M)')
  })
})

// ─── TC-006: Non-1m bracket content stripped without annotation ───

describe('TC-006: non-1m bracket content is stripped without annotation', () => {
  it('strips [200k] bracket and returns plain label', () => {
    expect(getModelDisplayLabel('claude-opus-4-6[200k]')).toBe('Opus 4.6')
  })
})

// ─── TC-007: Date-suffixed model IDs ───

describe('TC-007: date-suffixed model IDs with [1m]', () => {
  it('strips date suffix and appends (1M) for known model', () => {
    expect(getModelDisplayLabel('claude-haiku-4-5-20251001[1m]')).toBe('Haiku 4.5 (1M)')
  })
})
