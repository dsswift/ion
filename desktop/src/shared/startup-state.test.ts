import { describe, expect, it } from 'vitest'
import { isStartupReport, isStartupState } from './startup-state'

describe('startup contract guards', () => {
  it('accepts bounded renderer progress reports', () => {
    expect(isStartupReport({ source: 'owner', sequence: 2, status: 'Restoring tab 2 of 4…', ready: false })).toBe(true)
  })

  it('rejects invalid source, sequence, and unbounded status', () => {
    expect(isStartupReport({ source: 'splash', sequence: 1, status: 'Loading' })).toBe(false)
    expect(isStartupReport({ source: 'owner', sequence: -1, status: 'Loading' })).toBe(false)
    expect(isStartupReport({ source: 'studio', sequence: 1, status: 'x'.repeat(241) })).toBe(false)
  })

  it('accepts only complete coordinator state envelopes', () => {
    expect(isStartupState({
      sequence: 4,
      target: 'studio',
      source: 'studio',
      status: 'Ion Studio is ready',
      mode: 'loading',
      authenticationBusy: false,
      authenticationError: null,
      appVersion: '1.0.0',
      ownerReady: true,
      studioReady: true,
      error: null,
    })).toBe(true)
    expect(isStartupState({ sequence: 1, target: 'overlay' })).toBe(false)
  })
})
