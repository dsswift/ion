import { describe, it, expect, beforeEach } from 'vitest'
import {
  findActiveAutoFix,
  getInflight,
  setInflight,
  clearInflight,
} from '../slices/conflict-assist-dedupe'

describe('findActiveAutoFix', () => {
  it('returns the tab id when a conflict-auto-fix tab matches the directory', () => {
    const tabs = [
      { id: 'tab-1', tabRole: 'conflict-auto-fix' as const, workingDirectory: '/bench/josh' },
      { id: 'tab-2', tabRole: undefined, workingDirectory: '/bench/josh' },
    ]
    expect(findActiveAutoFix(tabs, '/bench/josh')).toBe('tab-1')
  })

  it('returns null when no auto-fix tab exists for the directory', () => {
    const tabs = [
      { id: 'tab-1', tabRole: 'conflict-auto-fix' as const, workingDirectory: '/bench/other' },
      { id: 'tab-2', tabRole: undefined, workingDirectory: '/bench/josh' },
    ]
    expect(findActiveAutoFix(tabs, '/bench/josh')).toBeNull()
  })

  it('returns null for an empty tab list', () => {
    expect(findActiveAutoFix([], '/bench/josh')).toBeNull()
  })

  it('distinguishes directories: same role, different directory', () => {
    const tabs = [
      { id: 'tab-a', tabRole: 'conflict-auto-fix' as const, workingDirectory: '/bench/a' },
      { id: 'tab-b', tabRole: 'conflict-auto-fix' as const, workingDirectory: '/bench/b' },
    ]
    expect(findActiveAutoFix(tabs, '/bench/a')).toBe('tab-a')
    expect(findActiveAutoFix(tabs, '/bench/b')).toBe('tab-b')
    expect(findActiveAutoFix(tabs, '/bench/c')).toBeNull()
  })
})

describe('inflight promise map', () => {
  beforeEach(() => {
    clearInflight('/a')
    clearInflight('/b')
  })

  it('stores and retrieves a pending promise per directory', () => {
    const p = Promise.resolve('tab-1')
    setInflight('/a', p)
    expect(getInflight('/a')).toBe(p)
    expect(getInflight('/b')).toBeUndefined()
  })

  it('clearInflight removes the entry', () => {
    setInflight('/a', Promise.resolve('tab-1'))
    clearInflight('/a')
    expect(getInflight('/a')).toBeUndefined()
  })
})
