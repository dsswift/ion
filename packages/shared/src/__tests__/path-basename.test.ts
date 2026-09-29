import { describe, it, expect } from 'vitest'
import { pathBasename, pathDirname } from '../paths'

describe('pathBasename', () => {
  it('reads the last segment in either separator style', () => {
    expect(pathBasename('/Users/example/repo')).toBe('repo')
    expect(pathBasename('C:\\Users\\example\\repo')).toBe('repo')
    expect(pathBasename('C:\\Users\\example\\repo\\')).toBe('repo')
    expect(pathBasename('plan.md')).toBe('plan.md')
  })
})

describe('pathDirname', () => {
  it('reads the parent in either separator style', () => {
    expect(pathDirname('/Users/example/repo')).toBe('/Users/example')
    expect(pathDirname('C:\\Users\\example\\repo')).toBe('C:\\Users\\example')
    expect(pathDirname('/repo')).toBe('/')
    expect(pathDirname('C:\\repo')).toBe('C:\\')
    expect(pathDirname('plan.md')).toBe('')
  })
})
