import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest'

const state = vi.hoisted(() => ({
  pidFile: '123',
  existing: new Set<number>(),
  scan: '',
  /** What the process lister calls a pid; a pid it has no name for throws. */
  images: new Map<number, string>(),
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/ion-user-data') } }))
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => state.pidFile),
}))
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((command: string, args: string[]) => {
    // The by-pid lookup: `ps -p N -o comm=`, or tasklist filtered on `PID eq N`.
    const pidArg = command === 'ps' ? args[1] : /^PID eq (\d+)$/.exec(args[1] ?? '')?.[1]
    if (pidArg === undefined) return state.scan
    const image = state.images.get(Number(pidArg))
    if (image === undefined) throw new Error('no such process')
    return command === 'ps' ? `${image}\n` : `"${image}","${pidArg}","Console","1","64,120 K"\r\n`
  }),
}))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))

import { detectRunningIon, isIonImage, processImageName, scanIonProcesses } from '../instance-guard'

const originalKill = process.kill
beforeEach(() => {
  state.pidFile = '123'
  state.existing = new Set()
  state.scan = ''
  state.images = new Map()
  vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
    if (state.existing.has(pid)) return true
    throw new Error('ESRCH')
  }) as typeof process.kill)
})

afterAll(() => { process.kill = originalKill })

describe('detectRunningIon', () => {
  it('uses a live foreign pid file before scanning processes', () => {
    state.existing.add(123)
    state.images.set(123, process.platform === 'win32' ? 'Ion.exe' : '/Applications/Ion.app/Contents/MacOS/Ion')
    expect(detectRunningIon()).toEqual({ pid: 123, source: 'pid_file' })
  })

  it('ignores a pid file whose pid the OS has since given to another program', () => {
    // An Ion that was uninstalled left its pid file; the number is now a system service.
    state.existing.add(123)
    state.images.set(123, process.platform === 'win32' ? 'svchost.exe' : '/usr/libexec/trustd')
    expect(detectRunningIon()).toBeNull()
  })

  it('still refuses when the process lister cannot name the pid', () => {
    state.existing.add(123)
    expect(detectRunningIon()).toEqual({ pid: 123, source: 'pid_file' })
  })

  it('falls back to a live Ion process when the pid file is stale', () => {
    // The scan reads this OS's process lister: tasklist CSV on win32, pgrep elsewhere.
    state.scan = process.platform === 'win32' ? '"Ion.exe","456","Console","1","64,120 K"\r\n' : '456\n'
    state.existing.add(456)
    expect(detectRunningIon()).toEqual({ pid: 456, source: 'process_scan' })
  })

  it('does not treat the new process as an already running Ion', () => {
    state.pidFile = String(process.pid)
    expect(detectRunningIon()).toBeNull()
  })
})

describe('processImageName', () => {
  it('reads the image name out of a tasklist row on win32, and the command path elsewhere', () => {
    state.images.set(5032, 'svchost.exe')
    expect(processImageName(5032, 'win32')).toBe('svchost.exe')
    state.images.set(77, '/Applications/Ion.app/Contents/MacOS/Ion')
    expect(processImageName(77, 'darwin')).toBe('/Applications/Ion.app/Contents/MacOS/Ion')
    expect(processImageName(999, 'darwin')).toBeNull()
  })

  it('knows Ion by its executable, packaged or run from a checkout', () => {
    expect(isIonImage('Ion.exe')).toBe(true)
    expect(isIonImage('/Applications/Ion.app/Contents/MacOS/Ion')).toBe(true)
    expect(isIonImage('C:\\dev\\ion\\node_modules\\electron\\dist\\electron.exe')).toBe(true)
    expect(isIonImage('svchost.exe')).toBe(false)
    expect(isIonImage('/usr/sbin/notificationd')).toBe(false)
  })
})

describe('scanIonProcesses', () => {
  it('reads pids out of tasklist CSV rows on win32', () => {
    state.scan = '"Ion.exe","4780","Console","1","120,004 K"\r\n"Ion.exe","8296","Console","1","64,120 K"\r\n'
    expect(scanIonProcesses('win32')).toEqual([4780, 8296])
  })

  it('finds nothing in tasklist\'s no-match sentence on win32', () => {
    state.scan = 'INFO: No tasks are running which match the specified criteria.\r\n'
    expect(scanIonProcesses('win32')).toEqual([])
  })

  it('reads pgrep output on darwin', () => {
    state.scan = '456\n789\n'
    expect(scanIonProcesses('darwin')).toEqual([456, 789])
  })
})
