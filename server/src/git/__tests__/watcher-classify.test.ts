import { describe, it, expect } from 'vitest'
import { classifyGitMetaChange } from '../watcher'

describe('classifyGitMetaChange', () => {
  it('POSIX paths classify unchanged', () => {
    expect(classifyGitMetaChange('/repo/.git/HEAD')).toBe('head:changed')
    expect(classifyGitMetaChange('/repo/.git/refs/heads/main')).toBe('refs:dirty')
    expect(classifyGitMetaChange('/repo/.git/index')).toBe('status:dirty')
    expect(classifyGitMetaChange('/repo/.git/config')).toBe('config:dirty')
  })

  it('Windows backslash paths classify the same as their POSIX equivalents', () => {
    expect(classifyGitMetaChange('C:\\repo\\.git\\refs\\heads\\main')).toBe('refs:dirty')
    expect(classifyGitMetaChange('C:\\repo\\.git\\HEAD')).toBe('head:changed')
    expect(classifyGitMetaChange('C:\\repo\\.git\\index')).toBe('status:dirty')
    expect(classifyGitMetaChange('C:\\repo\\.git\\config')).toBe('config:dirty')
  })

  it('an unrelated file returns null on both separator styles', () => {
    expect(classifyGitMetaChange('/repo/.git/objects/ab/cdef')).toBe(null)
    expect(classifyGitMetaChange('C:\\repo\\.git\\objects\\ab\\cdef')).toBe(null)
  })
})
