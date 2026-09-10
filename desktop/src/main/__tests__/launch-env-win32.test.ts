/**
 * win32 TEMP/TMP dangling-path repair, the Windows equivalent of TMPDIR
 * (which does not exist there). Split from launch-env.test.ts to keep the
 * platform pin and fs mock local to this file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

const existingDirs = new Set<string>()
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: (p: string) => existingDirs.has(p) }
})

import { planLaunchEnvironmentSanitization, type LaunchEnvironmentAccount } from '../launch-env'
import { join } from 'path'

const ACCOUNT: LaunchEnvironmentAccount = { username: 'operator', homedir: 'C:\\Users\\operator', shell: '' }
const originalPlatform = process.platform
const originalLocalAppData = process.env.LOCALAPPDATA

beforeEach(() => {
  existingDirs.clear()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  process.env.LOCALAPPDATA = join('C:\\Users\\operator', 'AppData', 'Local')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = originalLocalAppData
})

// dirExists here stands in for the caller-injected probe used for PWD/TMPDIR;
// TEMP/TMP repair on win32 resolves its replacement via existsSync directly
// (mocked above), so this only needs to answer for paths this suite passes
// as the dangling TEMP/TMP value itself.
const dirExists = (path: string): boolean => existingDirs.has(path)

describe('planLaunchEnvironmentSanitization — win32 TEMP/TMP', () => {
  it('corrects a dangling TEMP to %LOCALAPPDATA%\\Temp when that exists', () => {
    existingDirs.add(join('C:\\Users\\operator', 'AppData', 'Local', 'Temp'))
    const env: NodeJS.ProcessEnv = { TEMP: 'C:\\stale\\temp' }
    const plan = planLaunchEnvironmentSanitization(env, ACCOUNT, dirExists)

    expect(plan.correct.TEMP?.to).toBe(join('C:\\Users\\operator', 'AppData', 'Local', 'Temp'))
    expect(plan.correct.TEMP?.reason).toBe('dangling-tmpdir')
  })

  it('removes TEMP when no replacement directory exists', () => {
    const env: NodeJS.ProcessEnv = { TEMP: 'C:\\stale\\temp' }
    const plan = planLaunchEnvironmentSanitization(env, ACCOUNT, dirExists)

    expect(plan.remove).toContain('TEMP')
    expect(plan.correct.TEMP).toBeUndefined()
  })

  it('corrects a dangling TMP the same way', () => {
    existingDirs.add(join('C:\\Users\\operator', 'AppData', 'Local', 'Temp'))
    const env: NodeJS.ProcessEnv = { TMP: 'C:\\stale\\tmp' }
    const plan = planLaunchEnvironmentSanitization(env, ACCOUNT, dirExists)

    expect(plan.correct.TMP?.to).toBe(join('C:\\Users\\operator', 'AppData', 'Local', 'Temp'))
  })

  it('leaves a valid TEMP untouched', () => {
    existingDirs.add(join('C:\\Users\\operator', 'AppData', 'Local', 'Temp'))
    const env: NodeJS.ProcessEnv = { TEMP: join('C:\\Users\\operator', 'AppData', 'Local', 'Temp') }
    const plan = planLaunchEnvironmentSanitization(env, ACCOUNT, dirExists)

    expect(plan.correct.TEMP).toBeUndefined()
    expect(plan.remove).not.toContain('TEMP')
  })
})
