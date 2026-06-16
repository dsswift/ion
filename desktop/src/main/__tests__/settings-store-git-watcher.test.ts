/**
 * Tests for readGitWatcherIgnoredDirectories in settings-store.ts.
 *
 * Mocks fs at the boundary (existsSync + readFileSync) so each test controls
 * exactly what is "on disk". Uses the same electron mock pattern as
 * early-stop-policy.test.ts and vi.hoisted for the fs control object.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'os'

// vi.hoisted runs before all imports, making the returned value safe to use
// inside vi.mock factories (which are also hoisted).
const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn().mockReturnValue('{}'),
}))

vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

vi.mock('fs', () => fsMock)

const HOME = homedir()

import { readGitWatcherIgnoredDirectories } from '../settings-store'

describe('readGitWatcherIgnoredDirectories', () => {
  beforeEach(() => {
    fsMock.existsSync.mockReturnValue(true)
    fsMock.readFileSync.mockReturnValue('{}')
  })

  it('returns expanded default when key absent from disk', () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({}))
    const result = readGitWatcherIgnoredDirectories()
    expect(result).toEqual([HOME + '/.ion'])
  })

  it('returns [] when user explicitly stores []', () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ gitWatcherIgnoredDirectories: [] }))
    const result = readGitWatcherIgnoredDirectories()
    expect(result).toEqual([])
  })

  it('returns expanded default when stored value is non-array (string)', () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ gitWatcherIgnoredDirectories: 'bad' }))
    const result = readGitWatcherIgnoredDirectories()
    expect(result).toEqual([HOME + '/.ion'])
  })

  it('returns expanded default when stored value is a number', () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ gitWatcherIgnoredDirectories: 42 }))
    const result = readGitWatcherIgnoredDirectories()
    expect(result).toEqual([HOME + '/.ion'])
  })

  it('filters out non-string items from a stored array', () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ gitWatcherIgnoredDirectories: [42, '~/.ion', null, true] }))
    const result = readGitWatcherIgnoredDirectories()
    expect(result).toEqual([HOME + '/.ion'])
  })

  it('expands ~ in stored values', () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ gitWatcherIgnoredDirectories: ['~/.ion'] }))
    const result = readGitWatcherIgnoredDirectories()
    expect(result).toEqual([HOME + '/.ion'])
  })

  it('expands $HOME in stored values', () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ gitWatcherIgnoredDirectories: ['$HOME/work'] }))
    const result = readGitWatcherIgnoredDirectories()
    expect(result).toEqual([HOME + '/work'])
  })

  it('expands both ~ and $HOME in a mixed array', () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ gitWatcherIgnoredDirectories: ['~/.ion', '$HOME/work'] }))
    const result = readGitWatcherIgnoredDirectories()
    expect(result).toEqual([HOME + '/.ion', HOME + '/work'])
  })

  it('passes absolute paths through unchanged', () => {
    fsMock.readFileSync.mockReturnValue(JSON.stringify({ gitWatcherIgnoredDirectories: ['/tmp/skip'] }))
    const result = readGitWatcherIgnoredDirectories()
    expect(result).toEqual(['/tmp/skip'])
  })

  it('returns expanded default when settings file does not exist', () => {
    fsMock.existsSync.mockReturnValue(false)
    const result = readGitWatcherIgnoredDirectories()
    expect(result).toEqual([HOME + '/.ion'])
  })
})
