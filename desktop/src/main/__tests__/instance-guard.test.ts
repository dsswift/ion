import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest'

const state = vi.hoisted(() => ({
  pidFile: '123',
  existing: new Set<number>(),
  scan: '',
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/ion-user-data') } }))
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => state.pidFile),
}))
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => state.scan),
}))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))

import { detectRunningIon, scanIonProcesses } from '../instance-guard'

const originalKill = process.kill
beforeEach(() => {
  state.pidFile = '123'
  state.existing = new Set()
  state.scan = ''
  vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
    if (state.existing.has(pid)) return true
    throw new Error('ESRCH')
  }) as typeof process.kill)
})

afterAll(() => { process.kill = originalKill })

describe('detectRunningIon', () => {
  it('uses a live foreign pid file before scanning processes', () => {
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
