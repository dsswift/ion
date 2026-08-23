import { describe, expect, it } from 'vitest'
import { filterDirectoryNames, filterProjects, isDirectoryBrowseQuery, joinDirectoryPath, parseDirectoryBrowseQuery } from '../new-conversation-project-search'

const projects = [
  { dir: '/work/ion', displayName: 'ion', entry: { addedManually: false, lastUsedAt: 3 } },
  { dir: '/work/other/ion', displayName: 'ion (other)', entry: { addedManually: true, lastUsedAt: 2 } },
  { dir: '/work/t3code', displayName: 't3code', entry: { addedManually: false, lastUsedAt: 1 } },
]

describe('new conversation project search', () => {
  it('filters loaded projects by both name and full path without changing their order', () => {
    expect(filterProjects(projects, 'ion').map((project) => project.dir)).toEqual(['/work/ion', '/work/other/ion'])
    expect(filterProjects(projects, 'other').map((project) => project.dir)).toEqual(['/work/other/ion'])
  })

  it('recognizes only absolute and home-relative directory queries', () => {
    expect(isDirectoryBrowseQuery('/work')).toBe(true)
    expect(isDirectoryBrowseQuery('~/work')).toBe(true)
    expect(isDirectoryBrowseQuery('ion')).toBe(false)
  })

  it('splits a typed path into a parent listing and leaf filter', () => {
    expect(parseDirectoryBrowseQuery('/work/io')).toEqual({ parentPath: '/work', filter: 'io', hasTrailingSeparator: false })
    expect(parseDirectoryBrowseQuery('/work/')).toEqual({ parentPath: '/work', filter: '', hasTrailingSeparator: true })
    expect(parseDirectoryBrowseQuery('~/work')).toEqual({ parentPath: '~', filter: 'work', hasTrailingSeparator: false })
    expect(parseDirectoryBrowseQuery('/')).toEqual({ parentPath: '/', filter: '', hasTrailingSeparator: true })
    expect(parseDirectoryBrowseQuery('ion')).toBeNull()
  })

  it('joins directories safely and filters only matching path segments', () => {
    expect(joinDirectoryPath('/', 'work')).toBe('/work')
    expect(joinDirectoryPath('/work/', 'ion')).toBe('/work/ion')
    expect(filterDirectoryNames(['ion', 'infra', 't3code'], 'i')).toEqual(['ion', 'infra'])
  })
})
