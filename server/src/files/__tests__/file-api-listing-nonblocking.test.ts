/**
 * A directory listing on Windows must not start a process synchronously.
 *
 * It used to run PowerShell with `execFileSync` for the hidden attribute, once
 * per listing. The Explorer lists every open folder, so the server's event
 * loop stopped for several PowerShell starts in a row and every client of
 * that server froze with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const syncSpawns = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../ipc-validation', () => ({ isValidProjectPath: (p: string) => typeof p === 'string' && p.length > 0 }))
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>()
  const refuse = (name: string) => (): never => {
    syncSpawns.calls.push(name)
    throw new Error(`${name} must not run during a listing`)
  }
  return { ...real, execFileSync: refuse('execFileSync'), execSync: refuse('execSync'), spawnSync: refuse('spawnSync') }
})
vi.mock('../hidden-attribute-probe', () => ({
  hiddenAttributeProbe: { hiddenNames: vi.fn(async () => new Set(['AppData'])), dispose: vi.fn() },
}))

import { fsReadDir } from '../file-api'
import { hiddenAttributeProbe } from '../hidden-attribute-probe'

let dir: string
const realPlatform = process.platform
beforeEach(() => {
  syncSpawns.calls.length = 0
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ion-listing-')))
  Object.defineProperty(process, 'platform', { value: 'win32' })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
  rmSync(dir, { recursive: true, force: true })
})

describe('fsReadDir on Windows', () => {
  it('reads the hidden attribute from the shared probe and starts nothing synchronously', async () => {
    mkdirSync(join(dir, 'AppData'))
    mkdirSync(join(dir, 'src'))
    const { entries } = await fsReadDir({ directory: dir })
    expect(entries.find((e) => e.name === 'AppData')?.isHidden).toBe(true)
    expect(entries.find((e) => e.name === 'src')?.isHidden).toBe(false)
    expect(hiddenAttributeProbe.hiddenNames).toHaveBeenCalledWith(dir)
    expect(syncSpawns.calls).toEqual([])
  })

  it('lists a directory far larger than its stat concurrency, completely and in order', async () => {
    for (let i = 0; i < 200; i++) writeFileSync(join(dir, `f${String(i).padStart(3, '0')}.txt`), 'x')
    const { entries } = await fsReadDir({ directory: dir })
    expect(entries).toHaveLength(200)
    expect(entries.map((e) => e.name)).toEqual([...entries.map((e) => e.name)].sort())
  })
})
