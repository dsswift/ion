import { describe, it, expect } from 'vitest'
import { MAIN_INSTANCE_ID, sessionKey, parseSessionKey, tabIdFromKey, instanceIdFromKey } from '../session-key'

describe('session-key (Phase 4b: bare tabId)', () => {
  it('sessionKey returns bare tabId (no suffix)', () => {
    expect(sessionKey('tab1')).toBe('tab1')
    expect(sessionKey('tab1', 'ignored')).toBe('tab1')
    expect(MAIN_INSTANCE_ID).toBe('main')
  })

  it('parseSessionKey returns tabId + main for a bare key', () => {
    expect(parseSessionKey('tab1')).toEqual({ tabId: 'tab1', instanceId: 'main' })
  })

  it('parseSessionKey strips legacy :main suffix', () => {
    expect(parseSessionKey('tab1:main')).toEqual({ tabId: 'tab1', instanceId: 'main' })
  })

  it('parseSessionKey still parses arbitrary compound keys (backward compat)', () => {
    expect(parseSessionKey('tab1:inst-a')).toEqual({ tabId: 'tab1', instanceId: 'inst-a' })
  })

  it('tabIdFromKey extracts tabId from bare key', () => {
    expect(tabIdFromKey('tab1')).toBe('tab1')
    expect(tabIdFromKey('5f3a84665d57')).toBe('5f3a84665d57')
  })

  it('tabIdFromKey strips :main suffix', () => {
    expect(tabIdFromKey('tab1:main')).toBe('tab1')
  })

  it('instanceIdFromKey returns main for bare key', () => {
    expect(instanceIdFromKey('tab1')).toBe('main')
  })

  it('instanceIdFromKey returns the suffix for a compound key', () => {
    expect(instanceIdFromKey('tab1:inst-a')).toBe('inst-a')
  })

  it('no desktop code builds compound keys for conversations anymore', () => {
    // sessionKey never appends a suffix
    const key = sessionKey('abc-123')
    expect(key).toBe('abc-123')
    expect(key.includes(':')).toBe(false)
  })

  it('persisted legacy key loads to bare form via tabIdFromKey', () => {
    // A key saved as 'tab1:main' in tabs.json should resolve to 'tab1'
    expect(tabIdFromKey('tab1:main')).toBe('tab1')
    expect(tabIdFromKey('some-uuid:main')).toBe('some-uuid')
  })
})
