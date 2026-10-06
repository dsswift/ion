/**
 * project-rows — the Projects list's order and one-status-per-row rules, and
 * the folder box's path split (a trailing slash lists that folder, a partial
 * last segment filters it, `~` and `/` are roots).
 */
import { describe, expect, it } from 'vitest'
import type { EnvironmentJob, EnvironmentProject } from '@ion/shared/types-environment-admin'
import { buildProjectRows, jobStatus, projectStatus, repoNameFromUrl, rowMatches, splitTypedPath } from '../project-rows'

const project = (over: Partial<EnvironmentProject> & { dir: string; displayName: string }): EnvironmentProject => ({ entry: { addedManually: true, lastUsedAt: 0 }, exists: true, isGitRepo: true, ...over })
const job = (over: Partial<EnvironmentJob> & { id: string; dir: string }): EnvironmentJob => ({ kind: 'clone', phase: 'running', stage: 'receiving objects', startedAt: 1, ...over })

describe('buildProjectRows', () => {
  it('puts orphan jobs and failed clones first, then projects by name, and rides a running job on its project', () => {
    const rows = buildProjectRows(
      [project({ dir: '/b', displayName: 'Beta' }), project({ dir: '/a', displayName: 'alpha' })],
      [job({ id: 'on-a', dir: '/a', kind: 'setup' }), job({ id: 'new', dir: '/n' }), job({ id: 'bad', dir: '/x', phase: 'failed' }), job({ id: 'done', dir: '/d', phase: 'done' })],
    )
    expect(rows.map((r) => r.key)).toEqual(['job:new', 'job:bad', '/a', '/b'])
    const alpha = rows[2]
    expect(alpha.kind === 'project' && alpha.job?.id).toBe('on-a')
  })

  it('shows one row per folder for a create and the clone it started, and lists a failed create', () => {
    const creating = buildProjectRows([], [job({ id: 'clone', dir: '/n' }), job({ id: 'create', dir: '/n', kind: 'create', stage: 'cloning: receiving objects' }), job({ id: 'failed', dir: '/f', kind: 'create', phase: 'failed', error: 'name taken' })])
    expect(creating.map((r) => r.key)).toEqual(['job:create', 'job:failed'])
    const onProject = buildProjectRows([project({ dir: '/n', displayName: 'n' })], [job({ id: 'setup', dir: '/n', kind: 'setup' }), job({ id: 'create', dir: '/n', kind: 'create' })])
    expect(onProject[0].kind === 'project' && onProject[0].job?.id).toBe('create')
    expect(jobStatus(job({ id: 'f', dir: '/f', kind: 'create', phase: 'failed', error: 'name taken' }))).toMatchObject({ chip: 'create failed', dotLabel: 'Create failed: name taken' })
    expect(projectStatus(project({ dir: '/n', displayName: 'n' }), job({ id: 'c', dir: '/n', kind: 'create', percent: 40 }))).toMatchObject({ chip: 'creating 40%' })
  })
})

describe('projectStatus', () => {
  it('shows the one status that matters most', () => {
    expect(projectStatus(project({ dir: '/a', displayName: 'a', exists: false, trusted: false }), undefined)).toMatchObject({ chip: 'missing', dot: 'error' })
    expect(projectStatus(project({ dir: '/a', displayName: 'a', trusted: false }), undefined)).toMatchObject({ chip: 'not trusted', dot: 'warn' })
    expect(projectStatus(project({ dir: '/a', displayName: 'a' }), job({ id: 'j', dir: '/a', kind: 'setup', percent: 30 }))).toMatchObject({ chip: 'setting up 30%', dot: 'warn' })
    expect(projectStatus(project({ dir: '/a', displayName: 'a', setup: { state: 'failed', at: 1 } }), undefined)).toMatchObject({ chip: 'setup failed', dot: 'warn' })
    expect(projectStatus(project({ dir: '/a', displayName: 'a', isGitRepo: false }), undefined)).toMatchObject({ chip: 'not git', dot: 'ok' })
    expect(projectStatus(project({ dir: '/a', displayName: 'a', entry: { addedManually: false, lastUsedAt: 0, clonedByIon: true } }), undefined)).toMatchObject({ chip: 'cloned by Ion', dot: 'ok' })
    expect(projectStatus(project({ dir: '/a', displayName: 'a' }), undefined)).toMatchObject({ chip: null, dot: 'ok' })
  })
})

describe('rowMatches', () => {
  it('filters a project by name, path, or branch', () => {
    const [row] = buildProjectRows([project({ dir: '/src/ion', displayName: 'Ion', branch: 'feature/x' })], [])
    expect(rowMatches(row, 'ion')).toBe(true)
    expect(rowMatches(row, '/src')).toBe(true)
    expect(rowMatches(row, 'feature')).toBe(true)
    expect(rowMatches(row, 'zzz')).toBe(false)
  })
})

describe('repoNameFromUrl', () => {
  it('takes the last segment without .git', () => {
    expect(repoNameFromUrl('git@github.com:o/repo.git')).toBe('repo')
    expect(repoNameFromUrl('https://example.org/o/repo/')).toBe('repo')
  })
})

describe('splitTypedPath', () => {
  it('splits a Windows path on its own separator', () => {
    expect(splitTypedPath('C:\\Users\\example\\rep')).toEqual({ listPath: 'C:\\Users\\example', filter: 'rep' })
    expect(splitTypedPath('C:\\Users\\example\\')).toEqual({ listPath: 'C:\\Users\\example', filter: '' })
  })
  it('maps typed input onto the folder to list and the filter', () => {
    expect(splitTypedPath('')).toEqual({ listPath: '~', filter: '' })
    expect(splitTypedPath('~')).toEqual({ listPath: '~', filter: '' })
    expect(splitTypedPath('~/')).toEqual({ listPath: '~', filter: '' })
    expect(splitTypedPath('~/src/')).toEqual({ listPath: '~/src', filter: '' })
    expect(splitTypedPath('~/src/io')).toEqual({ listPath: '~/src', filter: 'io' })
    expect(splitTypedPath('/')).toEqual({ listPath: '/', filter: '' })
    expect(splitTypedPath('/Users')).toEqual({ listPath: '/', filter: 'Users' })
    expect(splitTypedPath('/Users/x/')).toEqual({ listPath: '/Users/x', filter: '' })
    expect(splitTypedPath('.hid')).toEqual({ listPath: '~', filter: '.hid' })
  })
})
