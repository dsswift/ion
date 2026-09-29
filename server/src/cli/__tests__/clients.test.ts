import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Pins the paired-devices CLI against a REAL booted server (the engine bridge
 * mocked as `pair.test.ts` does): it dials the local `studio.sock` and prints
 * the owner's pairings.
 */
const bridge = vi.hoisted(() => ({
  connect: vi.fn(() => Promise.resolve()),
  connected: true,
  request: vi.fn(() => Promise.resolve({ ok: true, data: { home: '/tmp', username: 'test', hostname: 'test-host', os: 'darwin', pathSep: '/' } })),
  on: vi.fn(),
}))
vi.mock('../../state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../state')>()
  return { ...actual, engineBridge: bridge }
})

import { main } from '../../main'
import { readPairedDevices } from '../clients'
import { credentialsStore } from '../../auth/credentials-store'
import { hostSubject } from '../../identity/paired-subject'
import type { ServerHandle } from '../../main'

let tmp: string
let originalIonDataDir: string | undefined
let handle: ServerHandle | null = null

beforeEach(() => {
  originalIonDataDir = process.env.ION_DATA_DIR
  tmp = mkdtempSync(join(tmpdir(), 'ion-clients-cli-'))
  process.env.ION_DATA_DIR = tmp
})

afterEach(async () => {
  if (handle) {
    await handle.close()
    handle = null
  }
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(tmp, { recursive: true, force: true })
})

describe('readPairedDevices against a booted server', () => {
  it('prints the owner\'s paired devices through the local door', async () => {
    writeFileSync(join(tmp, 'server.json'), JSON.stringify({ label: 'Test Lab', listen: { tcp: { port: 0 } } }))
    handle = await main()
    credentialsStore().add({ clientId: 'phone', secret: Buffer.alloc(32, 1), scopes: ['conversations:read'], subject: hostSubject(), kind: 'mobile', label: 'iPhone' })

    const result = await readPairedDevices({ kind: 'unix', path: join(tmp, 'studio.sock') }, 5000)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.devices).toEqual([expect.objectContaining({ clientId: 'phone', label: 'iPhone', kind: 'mobile', connected: false, self: false })])
  })

  it('reports an unreachable socket instead of hanging', async () => {
    const result = await readPairedDevices({ kind: 'unix', path: join(tmp, 'missing.sock') }, 2000)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('cannot reach the server') })
  })
})
