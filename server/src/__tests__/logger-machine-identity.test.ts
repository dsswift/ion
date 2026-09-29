/**
 * Every server.jsonl line names the device it came from, and a caller field
 * of the same name (a URL's or a git remote's host) cannot relabel it: log
 * pipelines label each line with the device by these keys.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { flushLogs, log, initLoggerMachineIdentity, _resetForTest as resetLoggerForTest } from '../logger'

let dir: string
let prevDataDir: string | undefined

beforeEach(() => {
  prevDataDir = process.env.ION_DATA_DIR
  dir = mkdtempSync(join(tmpdir(), 'ion-log-identity-'))
  process.env.ION_DATA_DIR = dir
  resetLoggerForTest()
})

afterEach(() => {
  resetLoggerForTest()
  if (prevDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = prevDataDir
  rmSync(dir, { recursive: true, force: true })
})

describe('machine identity on server log lines', () => {
  it('wins over a caller field of the same name and keeps the rest', () => {
    initLoggerMachineIdentity({ host: 'device-a', machineId: 'hw-1', mdmDeviceId: '', mdmSerial: '' })
    log('principal-source', 'no credential resolved', { subject: 'local:user', host: 'github.com' })
    flushLogs()

    const line = JSON.parse(readFileSync(join(dir, 'server.jsonl'), 'utf-8').trim().split('\n').pop() ?? '{}')
    expect(line.fields).toMatchObject({ host: 'device-a', machine_id: 'hw-1', subject: 'local:user' })
  })
})
