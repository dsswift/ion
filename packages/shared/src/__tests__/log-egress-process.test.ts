/**
 * One data directory, two shippers.
 *
 * The desktop imports this same egress stack from `@ion/server` and runs it in
 * Electron's main process while the server runs its own copy. They shared one
 * spool file and one cursor file, so their batches interleaved and each
 * overwrote the other's resume points -- and an OTLP sink saw every line, from
 * either, as `ion-desktop`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  adoptLegacyEgressFile,
  defaultEgressServiceName,
  egressFilePath,
  egressProcess,
  setEgressProcess,
} from '../log-egress-process'

let dir: string
let prevDataDir: string | undefined

beforeEach(() => {
  prevDataDir = process.env.ION_DATA_DIR
  dir = mkdtempSync(join(tmpdir(), 'ion-egress-process-'))
  process.env.ION_DATA_DIR = dir
})

afterEach(() => {
  setEgressProcess('server')
  if (prevDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = prevDataDir
  rmSync(dir, { recursive: true, force: true })
})

describe('egress process identity', () => {
  it('is the server unless a host says otherwise', () => {
    expect(egressProcess()).toBe('server')
    expect(defaultEgressServiceName()).toBe('ion-server')
  })

  it('gives each process its own spool and cursor files', () => {
    setEgressProcess('desktop')
    const desktopSpool = egressFilePath('spool.jsonl')
    const desktopCursors = egressFilePath('cursors.json')

    setEgressProcess('server')
    expect(egressFilePath('spool.jsonl')).not.toBe(desktopSpool)
    expect(egressFilePath('cursors.json')).not.toBe(desktopCursors)
    expect(desktopSpool).toBe(join(dir, '.desktop-egress-spool.jsonl'))
    expect(egressFilePath('spool.jsonl')).toBe(join(dir, '.server-egress-spool.jsonl'))
  })

  it('names the service after the process that shipped the line', () => {
    setEgressProcess('desktop')
    expect(defaultEgressServiceName()).toBe('ion-desktop')
    setEgressProcess('server')
    expect(defaultEgressServiceName()).toBe('ion-server')
  })

  it('adopts a pre-rename file, so undelivered batches are not stranded', () => {
    const legacy = join(dir, '.egress-spool.jsonl')
    writeFileSync(legacy, '{"msg":"a batch nobody has accepted yet"}\n')
    const target = egressFilePath('spool.jsonl')

    adoptLegacyEgressFile('.egress-spool.jsonl', target)

    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(target, 'utf-8')).toContain('a batch nobody has accepted yet')
  })

  it('never overwrites a file this process already has', () => {
    const legacy = join(dir, '.egress-spool.jsonl')
    const target = egressFilePath('spool.jsonl')
    writeFileSync(legacy, 'old\n')
    writeFileSync(target, 'current\n')

    adoptLegacyEgressFile('.egress-spool.jsonl', target)

    expect(readFileSync(target, 'utf-8')).toBe('current\n')
    expect(existsSync(legacy)).toBe(true)
  })

  it('does nothing when there is no pre-rename file', () => {
    const target = egressFilePath('spool.jsonl')
    adoptLegacyEgressFile('.egress-spool.jsonl', target)
    expect(existsSync(target)).toBe(false)
  })
})
