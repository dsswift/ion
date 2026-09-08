/**
 * win32 PATH-discovery behavior: no login-shell probes to run (there is no
 * login-shell concept on Windows), and the fallback entries are Windows
 * tool directories instead of the macOS Homebrew/system set.
 *
 * Split from cli-env.test.ts to keep the platform pin local to this file
 * and never bleed into the darwin/linux suite there. The 'path' module
 * itself is mocked to its win32 namespace: Node's path.delimiter/path.join
 * reflect the REAL host OS regardless of a process.platform override, so on
 * a macOS test runner they would silently stay POSIX-flavored without this.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { win32 as pathWin32 } from 'path'

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>()
  return { ...actual, ...actual.win32 }
})

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  logLines: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
}))

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mocks.execFileSync(...args),
}))

vi.mock('../logger', () => ({
  log: (_tag: string, msg: string, fields?: Record<string, unknown>) => { mocks.logLines.push({ msg, fields }) },
  warn: (_tag: string, msg: string, fields?: Record<string, unknown>) => { mocks.logLines.push({ msg, fields }) },
  debug: vi.fn(),
  error: vi.fn(),
}))

import { getCliPath, resetCliPathCacheForTests } from '../cli-env'

const originalPlatform = process.platform

beforeEach(() => {
  vi.clearAllMocks()
  mocks.logLines.length = 0
  resetCliPathCacheForTests()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env.PATH = 'C:\\a;C:\\b;C:\\a'
  process.env.APPDATA = 'C:\\Users\\x\\AppData\\Roaming'
  process.env.USERPROFILE = 'C:\\Users\\x'
  process.env.ProgramFiles = 'C:\\Program Files'
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

describe('getCliPath — win32', () => {
  it('deduplicates PATH entries and joins with the platform delimiter (;)', () => {
    const result = getCliPath()
    const entries = result.split(pathWin32.delimiter)
    // C:\a appears once despite being listed twice in process.env.PATH.
    expect(entries.filter((e) => e === 'C:\\a').length).toBe(1)
  })

  it('never runs a login-shell probe (execFileSync is never called)', () => {
    getCliPath()
    expect(mocks.execFileSync).not.toHaveBeenCalled()
  })

  it('the fallback set includes the npm global directory', () => {
    const result = getCliPath()
    expect(result).toContain(pathWin32.join('C:\\Users\\x\\AppData\\Roaming', 'npm'))
  })

  it('logs that probing was skipped, naming the platform', () => {
    getCliPath()
    const line = mocks.logLines.find((l) => l.msg === 'PATH probing skipped')
    expect(line).toBeDefined()
    expect(line?.fields?.platform).toBe('win32')
  })
})
