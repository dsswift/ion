import { describe, it, expect } from 'vitest'
import { badgeKindOf } from '../badges'

describe('badgeKindOf', () => {
  it('classifies the core tool families', () => {
    expect(badgeKindOf('Bash')).toBe('terminal')
    expect(badgeKindOf('Read')).toBe('search')
    expect(badgeKindOf('Grep')).toBe('search')
    expect(badgeKindOf('Glob')).toBe('search')
    expect(badgeKindOf('Edit')).toBe('edit')
    expect(badgeKindOf('Write')).toBe('edit')
    expect(badgeKindOf('NotebookEdit')).toBe('edit')
    expect(badgeKindOf('WebFetch')).toBe('web')
    expect(badgeKindOf('WebSearch')).toBe('web')
    expect(badgeKindOf('Task')).toBe('task')
    expect(badgeKindOf('Agent')).toBe('task')
  })
  it('unknown tools get the generic badge; empty gets none', () => {
    expect(badgeKindOf('SomeMcpTool')).toBe('generic')
    expect(badgeKindOf('')).toBeNull()
    expect(badgeKindOf(null)).toBeNull()
  })
})
