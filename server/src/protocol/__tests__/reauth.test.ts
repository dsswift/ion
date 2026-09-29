import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../engine/engine-bridge-fs', () => ({
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: true, data: { version: '1.2.3' } })),
  getEnterprisePolicy: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('../../state', () => ({
  engineBridge: { connected: true },
  deviceFocusMap: new Map(),
  state: { remoteTransport: null },
}))

import { startHarness, connectLocal, waitOpen, sendFrame, nextFrame, helloFrame, closeSocket, resetConnectionRegistryForTest, type Harness } from './harness'
import { connectionRegistry } from '../connection'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

let harness: Harness
let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(async () => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-studio-wire-reauth-data-'))
  process.env.ION_DATA_DIR = dataDir
  harness = await startHarness()
})

afterEach(async () => {
  await harness.close()
  resetConnectionRegistryForTest()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

describe('studio_reauth', () => {
  it('closes the connection with revoked when the bearer credential is not accepted', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame())
    const welcome = await nextFrame(ws)
    expect(welcome.type).toBe('studio_welcome')

    sendFrame(ws, { type: 'studio_reauth', credential: { kind: 'bearer', token: 'expired-or-unknown-token' } })
    const closeFrame = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_close' }>
    expect(closeFrame).toMatchObject({ type: 'studio_close', reason: 'revoked' })
    await closeSocket(ws)
  })

  it('leaves the connection registered until the process-wide close', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ clientId: 'reauth-lifecycle' }))
    await nextFrame(ws)
    expect(connectionRegistry.findByClientId('reauth-lifecycle')).toBeDefined()

    sendFrame(ws, { type: 'studio_reauth', credential: { kind: 'bearer', token: 'x' } })
    await nextFrame(ws) // studio_close
    await closeSocket(ws)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(connectionRegistry.findByClientId('reauth-lifecycle')).toBeUndefined()
  })
})
