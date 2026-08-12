/**
 * Tests for PATH discovery in the main process.
 *
 * THE DEFECT (the reason this file exists):
 * `getCliPath()` used to probe with a COMMAND STRING —
 * `execSync('/bin/zsh -ilc "echo $PATH"')`. execSync routes its argument
 * through `/bin/sh -c`, so `sh` consumed the double quotes and expanded `$PATH`
 * itself before zsh ever started. zsh echoed back an already-expanded literal,
 * so the probe returned the PATH the desktop already had:
 *
 *   PATH=/usr/bin:/bin sh -c '/bin/zsh -ilc "echo $PATH"'  -> /usr/bin:/bin
 *   PATH=/usr/bin:/bin /bin/zsh -ilc 'echo $PATH'          -> the real PATH
 *
 * Every probe exited 0 with plausible output, so the three-probe fallback loop
 * never noticed and the function was `return process.env.PATH` with extra steps.
 * Launched from Finder/launchd the Electron PATH is the stripped
 * /usr/bin:/bin:/usr/sbin:/sbin set, so terminal panes and every spawned tool
 * inherited that — which is why `dotnet` was "not found" despite being installed.
 *
 * Each test below fails against old implementation:
 *   - argv form — old code passed one string, never argv array.
 *   - rejects no-op probe — old code accepted first exit-0 result.
 *   - configured shell first — shell startup files define developer PATH.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  logLines: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
}))

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mocks.execFileSync(...args),
}))

vi.mock('../logger', () => ({
  log: (_tag: string, msg: string, fields?: Record<string, unknown>) => {
    mocks.logLines.push({ msg, fields })
  },
  warn: (_tag: string, msg: string, fields?: Record<string, unknown>) => {
    mocks.logLines.push({ msg, fields })
  },
  debug: vi.fn(),
  error: vi.fn(),
}))

import { getCliPath, getCliEnv, resetCliPathCacheForTests } from '../cli-env'

/** The PATH the Electron process starts with — stripped, as under launchd. */
const STRIPPED = '/usr/bin:/bin:/usr/sbin:/sbin'

/** What a correct probe returns: the operator's real, fuller PATH. */
const REAL_PATH = [
  '/home/test-user/.tool/bin',
  '/home/test-user/.local/bin',
  '/opt/toolchain/bin',
  '/opt/homebrew/bin',
  '/usr/local/share/dotnet',
  '/usr/bin',
  '/bin',
].join(':')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.logLines.length = 0
  resetCliPathCacheForTests()
  process.env.SHELL = '/bin/zsh'
  process.env.PATH = STRIPPED
})

describe('getCliPath — probe invocation form', () => {
  it('passes an ARGV ARRAY, never a shell command string', () => {
    mocks.execFileSync.mockReturnValue(REAL_PATH)

    getCliPath()

    expect(mocks.execFileSync).toHaveBeenCalled()
    const [file, args] = mocks.execFileSync.mock.calls[0]

    // The shell is its own argument, and `echo $PATH` is a separate array
    // element. If these were one string, an intermediate /bin/sh would expand
    // $PATH before the target shell ran — the original defect.
    expect(file).toBe('/bin/zsh')
    expect(Array.isArray(args)).toBe(true)
    expect(args).toEqual(['-ilc', 'echo $PATH'])
  })

  it('never embeds the probe command inside the executable argument', () => {
    mocks.execFileSync.mockReturnValue(REAL_PATH)

    getCliPath()

    // Direct regression assertion on the old string form.
    for (const [file] of mocks.execFileSync.mock.calls) {
      expect(String(file)).not.toContain('echo $PATH')
      expect(String(file)).not.toContain(' -ilc')
      expect(String(file)).not.toContain('"')
    }
  })

  it('probes configured shell interactively first, because startup files define PATH', () => {
    mocks.execFileSync.mockReturnValue(REAL_PATH)
    process.env.SHELL = '/custom/shell'

    getCliPath()

    expect(mocks.execFileSync.mock.calls[0].slice(0, 2)).toEqual([
      '/custom/shell',
      ['-ilc', 'echo $PATH'],
    ])
  })

  it('discards probe stderr so rc noise cannot corrupt the result', () => {
    mocks.execFileSync.mockReturnValue(REAL_PATH)

    getCliPath()

    // An interactive shell writes prompt/completion diagnostics to stderr;
    // this machine's .bash_aliases emits "command not found: complete".
    const opts = mocks.execFileSync.mock.calls[0][2] as { stdio: unknown[] }
    expect(opts.stdio[2]).toBe('ignore')
  })
})

describe('getCliPath — probe result validation', () => {
  it('rejects a probe that discovers nothing and tries the next', () => {
    // First probe returns exactly the PATH we already had — the signature of
    // the original bug. Exit code 0, plausible output, zero information.
    mocks.execFileSync
      .mockReturnValueOnce(STRIPPED)
      .mockReturnValueOnce(REAL_PATH)

    const result = getCliPath()

    expect(mocks.execFileSync).toHaveBeenCalledTimes(2)
    expect(result).toContain('/home/test-user/.tool/bin')
    expect(mocks.logLines.some((l) => l.msg.includes('discovered nothing new'))).toBe(true)
  })

  it('rejects a probe that returns a subset of the current PATH', () => {
    mocks.execFileSync
      .mockReturnValueOnce('/usr/bin')
      .mockReturnValueOnce(REAL_PATH)

    getCliPath()

    expect(mocks.execFileSync).toHaveBeenCalledTimes(2)
  })

  it('accepts the first probe that adds at least one entry', () => {
    mocks.execFileSync.mockReturnValue(REAL_PATH)

    const result = getCliPath()

    expect(mocks.execFileSync).toHaveBeenCalledTimes(1)
    expect(result).toContain('/usr/local/share/dotnet')
  })

  it('moves past a probe that throws', () => {
    mocks.execFileSync
      .mockImplementationOnce(() => { throw new Error('no tty') })
      .mockReturnValueOnce(REAL_PATH)

    const result = getCliPath()

    expect(result).toContain('/home/test-user/.tool/bin')
    expect(mocks.logLines.some((l) => l.msg.includes('probe failed'))).toBe(true)
  })
})

describe('getCliPath — result shape', () => {
  it('puts discovered entries before process and fallback entries', () => {
    mocks.execFileSync.mockReturnValue(REAL_PATH)

    const entries = getCliPath().split(':')

    // Shell PATH controls executable resolution. Process and fallback entries
    // remain available only after discovered entries.
    expect(entries).toContain('/usr/bin')
    expect(entries).toContain('/home/test-user/.tool/bin')
    expect(entries.indexOf('/home/test-user/.tool/bin')).toBeLessThan(entries.indexOf('/usr/bin'))
  })

  it('deduplicates while preserving first-seen order', () => {
    mocks.execFileSync.mockReturnValue('/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin:/new/entry')

    const entries = getCliPath().split(':')
    const unique = new Set(entries)

    expect(entries.length).toBe(unique.size)
    expect(entries).toContain('/new/entry')
  })

  it('falls back to a usable PATH when every probe fails', () => {
    mocks.execFileSync.mockImplementation(() => { throw new Error('nope') })

    const result = getCliPath()

    // Degraded, but never empty — an empty PATH would break every subprocess.
    expect(result).toContain('/usr/bin')
    expect(result).toContain('/opt/homebrew/bin')
    expect(mocks.logLines.some((l) => l.msg.includes('every PATH probe failed'))).toBe(true)
  })

  it('memoizes so repeated calls do not re-probe', () => {
    mocks.execFileSync.mockReturnValue(REAL_PATH)

    const first = getCliPath()
    const second = getCliPath()

    expect(first).toBe(second)
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1)
  })

  it('does not log raw PATH values', () => {
    mocks.execFileSync.mockReturnValue(REAL_PATH)

    getCliPath()

    for (const line of mocks.logLines) {
      expect(line.fields).not.toHaveProperty('path')
      expect(line.fields).not.toHaveProperty('discovered')
      expect(JSON.stringify(line.fields)).not.toContain(REAL_PATH)
    }
  })
  it('logs winning probe and contribution count', () => {
    mocks.execFileSync.mockReturnValue(REAL_PATH)

    getCliPath()

    const line = mocks.logLines.find((l) => l.msg === 'PATH discovered')
    expect(line?.fields).toMatchObject({ probe: 'user-shell-interactive-login' })
    expect(line?.fields?.entries_added).toBeGreaterThan(0)
  })
})

describe('getCliEnv', () => {
  it('supplies the discovered PATH and strips CLAUDECODE', () => {
    mocks.execFileSync.mockReturnValue(REAL_PATH)
    process.env.CLAUDECODE = '1'

    const env = getCliEnv()

    expect(env.PATH).toContain('/usr/local/share/dotnet')
    expect(env.CLAUDECODE).toBeUndefined()
    delete process.env.CLAUDECODE
  })

  it('applies an overlay without losing the discovered PATH', () => {
    mocks.execFileSync.mockReturnValue(REAL_PATH)

    const env = getCliEnv({ ION_DESKTOP_TAB_ID: 'tab-a' })

    expect(env.ION_DESKTOP_TAB_ID).toBe('tab-a')
    expect(env.PATH).toContain('/home/test-user/.tool/bin')
  })
})
