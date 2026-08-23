/**
 * temp-dir.test.ts — tests for operation-scoped temp directories.
 *
 * Validates:
 *   - createOperationDir creates unique dirs under ~/.ion/tmp/
 *   - cleanupDir removes a directory and contents
 *   - cleanupFile removes a single file
 *   - pruneOperationDirs clears abandoned Ion-owned operation dirs
 */

import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createOperationDir, cleanupDir, cleanupFile, pruneOperationDirs } from '../utils/temp-dir'

describe('createOperationDir', () => {
  it('creates a directory that exists on disk', () => {
    const dir = createOperationDir('test-op')
    expect(existsSync(dir)).toBe(true)
    cleanupDir(dir)
  })

  it('returns unique dirs on successive calls', () => {
    const a = createOperationDir('test-op')
    const b = createOperationDir('test-op')
    expect(a).not.toBe(b)
    cleanupDir(a)
    cleanupDir(b)
  })

  it('includes prefix in dir name', () => {
    const dir = createOperationDir('transcribe')
    expect(dir).toContain('transcribe-')
    cleanupDir(dir)
  })
})

describe('cleanupDir', () => {
  it('removes a directory and its contents', () => {
    const dir = createOperationDir('cleanup-test')
    writeFileSync(join(dir, 'file.txt'), 'data')
    mkdirSync(join(dir, 'subdir'))
    writeFileSync(join(dir, 'subdir', 'nested.txt'), 'nested')

    cleanupDir(dir)
    expect(existsSync(dir)).toBe(false)
  })

  it('does not throw on nonexistent dir', () => {
    expect(() => cleanupDir('/nonexistent-path-that-wont-exist')).not.toThrow()
  })
})

describe('cleanupFile', () => {
  it('removes a single file', () => {
    const dir = createOperationDir('file-test')
    const f = join(dir, 'tmp.bin')
    writeFileSync(f, 'bytes')
    expect(existsSync(f)).toBe(true)

    cleanupFile(f)
    expect(existsSync(f)).toBe(false)
    cleanupDir(dir)
  })

  it('does not throw on nonexistent file', () => {
    expect(() => cleanupFile('/nonexistent-file')).not.toThrow()
  })
})

describe('pruneOperationDirs', () => {
  it('does not throw when tmp root does not exist', () => {
    expect(() => pruneOperationDirs()).not.toThrow()
  })
})
