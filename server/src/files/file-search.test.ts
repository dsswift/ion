import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rankFiles, scoreFileMatch, searchFiles } from './file-search'

describe('rankFiles', () => {
  const files = [
    'docs/input/notes.md',
    'desktop/src/renderer/components/InputBar.tsx',
    'desktop/src/renderer/components/InputBarSend.ts',
    'server/src/index.ts',
  ]

  it('puts a file-name hit above a directory hit', () => {
    expect(rankFiles(files, 'input', 10)[0]).toBe('desktop/src/renderer/components/InputBar.tsx')
    expect(rankFiles(files, 'input', 10)).toContain('docs/input/notes.md')
  })

  it('matches a subsequence across segments and drops non-matches', () => {
    expect(rankFiles(files, 'ibs', 10)[0]).toBe('desktop/src/renderer/components/InputBarSend.ts')
    expect(rankFiles(files, 'zzz', 10)).toEqual([])
    expect(scoreFileMatch('a/b.ts', 'ba')).toBeNull()
  })

  it('keeps the given order for an empty query and honors the limit', () => {
    expect(rankFiles(files, '', 2)).toEqual(files.slice(0, 2))
  })
})

describe('searchFiles', () => {
  let dir: string
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'ion-file-search-'))) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function seed(): void {
    mkdirSync(join(dir, 'src'), { recursive: true })
    mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true })
    writeFileSync(join(dir, 'src/alpha.ts'), '')
    writeFileSync(join(dir, 'src/ignored.log'), '')
    writeFileSync(join(dir, 'node_modules/pkg/alpha.js'), '')
  }

  it('lists tracked and untracked files in a git checkout, never ignored ones', async () => {
    seed()
    writeFileSync(join(dir, '.gitignore'), '*.log\nnode_modules\n')
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const result = await searchFiles({ directory: dir, query: '' })
    expect(result.source).toBe('git')
    expect(result.files.sort()).toEqual(['.gitignore', 'src/alpha.ts'])
  })

  it('walks a directory that is not a git checkout, skipping dependency folders', async () => {
    seed()
    const result = await searchFiles({ directory: dir, query: 'alpha' })
    expect(result.source).toBe('walk')
    expect(result.files).toEqual(['src/alpha.ts'])
  })

  it('refuses an invalid directory', async () => {
    expect(await searchFiles({ directory: '', query: 'a' })).toMatchObject({ files: [], error: 'Invalid path' })
  })
})
