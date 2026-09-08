import { describe, it, expect } from 'vitest'
import { isAbsolutePath, pathSegments, joinPath } from '../paths'

describe('isAbsolutePath', () => {
  it('a POSIX absolute path', () => expect(isAbsolutePath('/Users/x/project')).toBe(true))
  it('a Windows drive-letter path with backslashes', () => expect(isAbsolutePath('C:\\Users\\x')).toBe(true))
  it('a Windows drive-letter path with forward slashes', () => expect(isAbsolutePath('C:/Users/x')).toBe(true))
  it('a UNC share', () => expect(isAbsolutePath('\\\\server\\share')).toBe(true))
  it('a relative path', () => expect(isAbsolutePath('relative/path')).toBe(false))
  it('a tilde-prefixed path is not absolute', () => expect(isAbsolutePath('~/project')).toBe(false))
  it('a bare drive with no separator is not absolute', () => expect(isAbsolutePath('C:foo')).toBe(false))
})

describe('pathSegments', () => {
  it('splits a POSIX path', () => expect(pathSegments('/Users/x/project')).toEqual(['Users', 'x', 'project']))
  it('splits a Windows path', () => expect(pathSegments('C:\\Users\\x\\project')).toEqual(['C:', 'Users', 'x', 'project']))
  it('splits a mixed-separator path', () => expect(pathSegments('a/b\\c')).toEqual(['a', 'b', 'c']))
  it('drops empty segments from repeated separators', () => expect(pathSegments('a//b')).toEqual(['a', 'b']))
})

describe('joinPath', () => {
  it('joins with a forward slash when the base uses one', () => expect(joinPath('/Users/x', 'project')).toBe('/Users/x/project'))
  it('joins with a backslash when the base uses one', () => expect(joinPath('C:\\Users\\x', 'project')).toBe('C:\\Users\\x\\project'))
  it('does not double the separator when base already ends with one', () => expect(joinPath('/Users/x/', 'project')).toBe('/Users/x/project'))
  it('defaults to forward slash when the base has no separator at all', () => expect(joinPath('base', 'rel')).toBe('base/rel'))
})
