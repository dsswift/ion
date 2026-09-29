import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { searchText } from './text-search'

describe('searchText', () => {
  let dir: string
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'ion-text-search-'))) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function seed(): void {
    mkdirSync(join(dir, 'infra'), { recursive: true })
    mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true })
    writeFileSync(join(dir, 'infra/main.tf'), [
      'resource "x" "y" {',
      '  principal_id = var.cloudops_grafana_principal_id',
      '  # CLOUDOPS_GRAFANA_PRINCIPAL_ID documented',
      '}',
    ].join('\n'))
    writeFileSync(join(dir, 'infra/vars.tf'), 'variable "cloudops_grafana_principal_id" {}\n')
    writeFileSync(join(dir, 'build.log'), 'cloudops_grafana_principal_id\n')
    writeFileSync(join(dir, 'node_modules/pkg/index.js'), 'cloudops_grafana_principal_id\n')
  }

  function summary(result: Awaited<ReturnType<typeof searchText>>): Record<string, number[]> {
    return Object.fromEntries(result.files.map((f) => [f.relativePath, f.matches.map((m) => m.line)]))
  }

  it('greps a git checkout, grouping lines by file and skipping ignored files', async () => {
    seed()
    writeFileSync(join(dir, '.gitignore'), '*.log\nnode_modules\n')
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const result = await searchText({ roots: [dir], query: 'cloudops_grafana_principal_id' })
    expect(summary(result)).toEqual({ 'infra/main.tf': [2, 3], 'infra/vars.tf': [1] })
    expect(result.totalMatches).toBe(3)
    const first = result.files.find((f) => f.relativePath === 'infra/main.tf')!
    expect(first.path).toBe(join(dir, 'infra/main.tf'))
    expect(first.matches[0]).toMatchObject({ line: 2, column: 22, length: 29 })
    expect(first.matches[0].ranges).toEqual([[21, 50]])
  })

  it('honours case sensitivity and whole-word matching on the git path', async () => {
    seed()
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const exact = await searchText({ roots: [join(dir, 'infra')], query: 'CLOUDOPS_GRAFANA', caseSensitive: true })
    expect(summary(exact)).toEqual({ 'main.tf': [3] })
    const word = await searchText({ roots: [join(dir, 'infra')], query: 'principal_id', wholeWord: true })
    expect(summary(word)).toEqual({ 'main.tf': [2] })
  })

  it('walks a directory that is not a git checkout, skipping dependency folders', async () => {
    seed()
    const result = await searchText({ roots: [dir], query: 'grafana_principal' })
    expect(summary(result)).toEqual({ 'build.log': [1], 'infra/main.tf': [2, 3], 'infra/vars.tf': [1] })
  })

  it('stops at maxResults and says so', async () => {
    seed()
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const result = await searchText({ roots: [dir], query: 'cloudops', maxResults: 2 })
    expect(result.totalMatches).toBe(2)
    expect(result.truncated).toBe(true)
  })

  it('refuses invalid roots and multi-line queries', async () => {
    expect(await searchText({ roots: ['relative'], query: 'a' })).toMatchObject({ files: [], error: 'Invalid path' })
    expect(await searchText({ roots: [dir], query: 'a\nb' })).toMatchObject({ error: 'Search text must be a single line' })
    expect(await searchText({ roots: [dir], query: '' })).toEqual({ files: [], totalMatches: 0, truncated: false })
  })
})
