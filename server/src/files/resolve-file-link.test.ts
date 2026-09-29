import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveFileLink } from './resolve-file-link'

describe('resolveFileLink', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ion-resolve-link-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('resolves a relative path against the working directory and normalizes ./', () => {
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, 'docs', 'plan.md'), '# plan')
    expect(resolveFileLink({ path: './docs/plan.md', cwd: dir })).toEqual({ path: join(dir, 'docs', 'plan.md'), exists: true, isDirectory: false, size: 6 })
  })

  it('expands ~/ with this machine\'s own home directory', () => {
    const target = resolveFileLink({ path: '~/', cwd: dir })
    expect(target.path).toBe(homedir())
    expect(target.isDirectory).toBe(true)
  })

  it('reports a missing file with its resolved path, and rejects a malformed request', () => {
    expect(resolveFileLink({ path: '/nope/missing.docx', cwd: dir })).toEqual({ path: '/nope/missing.docx', exists: false, isDirectory: false, size: 0 })
    expect(resolveFileLink({ path: 'a\nb', cwd: dir }).exists).toBe(false)
    expect(resolveFileLink(null).path).toBe('')
  })
})
