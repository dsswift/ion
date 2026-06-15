import { describe, it, expect } from 'vitest'
import { MAIN_INSTANCE_ID, sessionKey, parseSessionKey, tabIdFromKey, instanceIdFromKey, isCompoundKey } from '../session-key'

describe('session-key', () => {
  it('builds a compound key with the main sentinel by default', () => {
    expect(sessionKey('tab1')).toBe('tab1:main')
    expect(MAIN_INSTANCE_ID).toBe('main')
  })

  it('builds a compound key with an explicit instance id', () => {
    expect(sessionKey('tab1', 'inst-a')).toBe('tab1:inst-a')
  })

  it('parses a compound key', () => {
    expect(parseSessionKey('tab1:inst-a')).toEqual({ tabId: 'tab1', instanceId: 'inst-a' })
    expect(parseSessionKey('tab1:main')).toEqual({ tabId: 'tab1', instanceId: 'main' })
  })

  it('tolerates a legacy bare-tabId key by defaulting the instance to main', () => {
    expect(parseSessionKey('tab1')).toEqual({ tabId: 'tab1', instanceId: 'main' })
    expect(tabIdFromKey('tab1')).toBe('tab1')
    expect(instanceIdFromKey('tab1')).toBe('main')
  })

  it('round-trips build → parse', () => {
    const k = sessionKey('abc-123', 'inst-x')
    expect(parseSessionKey(k)).toEqual({ tabId: 'abc-123', instanceId: 'inst-x' })
    expect(tabIdFromKey(k)).toBe('abc-123')
    expect(instanceIdFromKey(k)).toBe('inst-x')
  })

  it('handles a tabId that itself contains no colon and an instanceId with hyphens', () => {
    expect(tabIdFromKey('5f3a:84665d57')).toBe('5f3a')
    expect(instanceIdFromKey('5f3a:84665d57')).toBe('84665d57')
  })

  describe('isCompoundKey — stream discriminator predicate', () => {
    it('is true for a compound key with an explicit instance segment', () => {
      expect(isCompoundKey('tab1:inst-a')).toBe(true)
      expect(isCompoundKey('tab1:main')).toBe(true)
    })

    it('is false for a bare tabId (no instance segment)', () => {
      expect(isCompoundKey('tab1')).toBe(false)
      expect(isCompoundKey('5f3a84665d57')).toBe(false)
    })

    it('distinguishes a plain conversation wire key (bare) from an extension-hosted instance (compound)', () => {
      // A plain conversation's raw events arrive bare and are dropped by the
      // raw-stream discriminator (handled via the normalized stream instead);
      // an extension-hosted instance's compound key passes through.
      expect(isCompoundKey(sessionKey('tab1', 'inst-a'))).toBe(true)
      expect(isCompoundKey('tab1')).toBe(false)
    })
  })
})
