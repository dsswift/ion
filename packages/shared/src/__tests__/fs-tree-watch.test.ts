import { describe, expect, it } from 'vitest'
import { relativeTreeDirectory } from '../fs-tree-watch'

describe('relativeTreeDirectory', () => {
  it('answers the empty string for the root itself, however it is spelled', () => {
    expect(relativeTreeDirectory('/repo', '/repo')).toBe('')
    expect(relativeTreeDirectory('/repo/', '/repo')).toBe('')
    expect(relativeTreeDirectory('C:\\Users\\dev\\repo', 'c:/Users/dev/repo')).toBe('')
  })

  it('answers a forward-slashed path for a directory inside the root', () => {
    expect(relativeTreeDirectory('/repo', '/repo/src/deep')).toBe('src/deep')
    expect(relativeTreeDirectory('C:/Users/dev/repo', 'C:\\Users\\dev\\repo\\src\\deep')).toBe('src/deep')
  })

  it('answers null for a directory outside the root, including a same-prefix sibling', () => {
    expect(relativeTreeDirectory('/repo', '/repo-other/src')).toBeNull()
    expect(relativeTreeDirectory('/repo', '/elsewhere')).toBeNull()
    expect(relativeTreeDirectory('/repo/src', '/repo')).toBeNull()
  })

  it('keeps case significant off Windows', () => {
    expect(relativeTreeDirectory('/Repo', '/repo/src')).toBeNull()
  })
})
