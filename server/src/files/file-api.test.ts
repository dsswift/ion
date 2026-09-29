/**
 * Pins the headless filesystem API the Explorer and file editor read.
 *
 * Context: these bodies lived behind `ipcMain.handle` in
 * `desktop/src/main/ipc/files.ts`, so a browser Studio client rendered the
 * Explorer as a root node with no children and every file as "preview is not
 * available" — `filesDirect` was false for want of a transport, not because
 * the server could not read a directory.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The shared validator refuses paths outside a known project root; the tests
// exercise the API's own behavior, so it is stubbed to accept real absolute
// paths and still refuse the empty/relative ones the callers guard against.
vi.mock('../ipc-validation', () => ({
  isValidProjectPath: (p: string) => typeof p === 'string' && p.startsWith('/'),
}))

import * as fileApi from './file-api'

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ion-file-api-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('fsReadDir', () => {
  it('lists directories first, then files, case-insensitively by name', () => {
    writeFileSync(join(dir, 'b.txt'), 'b')
    writeFileSync(join(dir, 'A.txt'), 'a')
    mkdirSync(join(dir, 'zdir'))
    const result = fileApi.fsReadDir({ directory: dir })
    expect(result.error).toBeUndefined()
    expect(result.entries.map((e) => e.name)).toEqual(['zdir', 'A.txt', 'b.txt'])
    expect(result.entries[0].isDirectory).toBe(true)
  })

  it('marks dot-prefixed entries hidden and drops .DS_Store entirely', () => {
    writeFileSync(join(dir, '.hidden'), 'x')
    writeFileSync(join(dir, '.DS_Store'), 'x')
    const names = fileApi.fsReadDir({ directory: dir }).entries.map((e) => e.name)
    expect(names).toContain('.hidden')
    expect(names).not.toContain('.DS_Store')
    expect(fileApi.fsReadDir({ directory: dir }).entries.find((e) => e.name === '.hidden')!.isHidden).toBe(true)
  })

  it('refuses an invalid path instead of throwing', () => {
    expect(fileApi.fsReadDir({ directory: 'relative/path' })).toEqual({ entries: [], error: 'Invalid path' })
  })
})

describe('fsReadFile', () => {
  it('returns text content', () => {
    writeFileSync(join(dir, 'a.txt'), 'hello')
    expect(fileApi.fsReadFile({ filePath: join(dir, 'a.txt') })).toEqual({ content: 'hello' })
  })

  it('refuses a binary file rather than returning mojibake', () => {
    writeFileSync(join(dir, 'bin'), Buffer.from([0x00, 0x01, 0x02]))
    expect(fileApi.fsReadFile({ filePath: join(dir, 'bin') })).toEqual({ content: null, error: 'Binary file' })
  })

  it('refuses a file over the read cap', () => {
    writeFileSync(join(dir, 'big'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x41))
    expect(fileApi.fsReadFile({ filePath: join(dir, 'big') }).error).toBe('File too large (>2MB)')
  })
})

describe('mutations', () => {
  it('creates, writes, renames, and deletes', () => {
    const a = join(dir, 'a.txt')
    expect(fileApi.fsCreateFile({ filePath: a })).toEqual({ ok: true })
    expect(fileApi.fsWriteFile({ filePath: a, content: 'v1' })).toEqual({ ok: true })
    expect(readFileSync(a, 'utf-8')).toBe('v1')

    const b = join(dir, 'b.txt')
    expect(fileApi.fsRename({ oldPath: a, newPath: b })).toEqual({ ok: true })
    expect(existsSync(a)).toBe(false)

    expect(fileApi.fsDelete({ targetPath: b })).toEqual({ ok: true })
    expect(existsSync(b)).toBe(false)
  })

  it('refuses to overwrite an existing file on create', () => {
    const a = join(dir, 'a.txt')
    writeFileSync(a, 'x')
    expect(fileApi.fsCreateFile({ filePath: a })).toEqual({ ok: false, error: 'File already exists' })
  })

  it('creates nested directories', () => {
    const nested = join(dir, 'x', 'y')
    expect(fileApi.fsCreateDir({ dirPath: nested })).toEqual({ ok: true })
    expect(existsSync(nested)).toBe(true)
  })

  it('refuses every mutation on an invalid path', () => {
    for (const result of [
      fileApi.fsWriteFile({ filePath: 'rel', content: '' }),
      fileApi.fsCreateDir({ dirPath: 'rel' }),
      fileApi.fsCreateFile({ filePath: 'rel' }),
      fileApi.fsRename({ oldPath: 'rel', newPath: 'rel2' }),
      fileApi.fsDelete({ targetPath: 'rel' }),
    ]) {
      expect(result).toEqual({ ok: false, error: 'Invalid path' })
    }
  })
})

describe('watching', () => {
  it('ref-counts a watch so a second watcher does not double-close it', () => {
    const a = join(dir, 'a.txt')
    writeFileSync(a, 'x')
    const emit = vi.fn()
    expect(fileApi.fsWatchFile({ filePath: a }, emit)).toEqual({ ok: true })
    expect(fileApi.fsWatchFile({ filePath: a }, emit)).toEqual({ ok: true })
    // One release leaves the watch alive; the second tears it down.
    expect(fileApi.fsUnwatchFile({ filePath: a })).toEqual({ ok: true })
    expect(fileApi.fsUnwatchFile({ filePath: a })).toEqual({ ok: true })
    // Releasing an unwatched path is a no-op, never an error.
    expect(fileApi.fsUnwatchFile({ filePath: a })).toEqual({ ok: true })
  })
})

describe('fsExists', () => {
  it('answers false for an invalid path rather than throwing', () => {
    expect(fileApi.fsExists({ targetPath: 'rel' })).toEqual({ exists: false })
  })
  it('answers truthfully for a real path', () => {
    expect(fileApi.fsExists({ targetPath: dir })).toEqual({ exists: true })
  })
})
