/**
 * Tests for the pure POSIX path helpers `graph-model-edges.ts` needs
 * because it runs in the renderer and cannot import Node's `path` module.
 */
import { describe, expect, it } from 'vitest'
import { dirnamePath, isAbsolutePath, joinPaths, normalizePath } from '../graph-model-path'

describe('isAbsolutePath', () => {
  it('a leading slash is absolute', () => {
    expect(isAbsolutePath('/a/b')).toBe(true)
  })
  it('a relative path is not absolute', () => {
    expect(isAbsolutePath('a/b')).toBe(false)
    expect(isAbsolutePath('./a')).toBe(false)
  })
})

describe('dirnamePath', () => {
  it('returns the parent directory', () => {
    expect(dirnamePath('/root/a/x.md')).toBe('/root/a')
  })
  it('returns / for a top-level file', () => {
    expect(dirnamePath('/x.md')).toBe('/')
  })
  it('returns . for a bare filename', () => {
    expect(dirnamePath('x.md')).toBe('.')
  })
})

describe('joinPaths / normalizePath', () => {
  it('joins and normalizes a relative segment', () => {
    expect(joinPaths('/root/a', './b.md')).toBe('/root/a/b.md')
  })
  it('resolves a parent-relative segment', () => {
    expect(joinPaths('/root/a', '../notes/b.md')).toBe('/root/notes/b.md')
  })
  it('collapses repeated slashes', () => {
    expect(normalizePath('/root//a///b.md')).toBe('/root/a/b.md')
  })
  it('a .. past the root on an absolute path does not escape', () => {
    expect(normalizePath('/../../a')).toBe('/a')
  })
  it('preserves relative .. segments on a relative path', () => {
    expect(normalizePath('../a')).toBe('../a')
  })
})
