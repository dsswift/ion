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
import { publishStudioEvent } from '../events'

let harness: Harness
let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(async () => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-studio-wire-buffer-data-'))
  process.env.ION_DATA_DIR = dataDir
})

afterEach(async () => {
  await harness.close()
  resetConnectionRegistryForTest()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

describe('per-connection send buffer overflow', () => {
  it('closes a connection with slow_client once its send buffer exceeds the cap, and a reconnect gets a fresh welcome', async () => {
    // A cap comfortably larger than one studio_welcome (whose settings/
    // worktree/automation payload size depends on this machine's real
    // ~/.ion content, which the test does not control) but far smaller than
    // the burst of large events below, so the overflow is deterministic
    // without depending on OS-level backpressure/read timing.
    harness = await startHarness({ bufferCapBytes: 300_000 })

    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ clientId: 'slow-client' }))
    const welcome = await nextFrame(ws)
    expect(welcome.type).toBe('studio_welcome')

    // Never read further frames from this socket -- our own accounting
    // (BoundedQueue) detects and acts on the overflow synchronously as each
    // `conn.send()` call pushes bytes, rather than depending on the
    // client actually draining the socket.
    const bigPayload = 'x'.repeat(100_000)
    for (let i = 0; i < 5; i++) {
      publishStudioEvent('ion:settings-changed', [{ blob: bigPayload }])
    }

    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
      setTimeout(resolve, 2000)
    })
    expect(ws.readyState === ws.CLOSED || ws.readyState === ws.CLOSING).toBe(true)

    // Reconnect: a fresh connection gets a fresh studio_welcome, proving the
    // overflowed connection's teardown did not wedge the listener.
    const ws2 = connectLocal(harness)
    await waitOpen(ws2)
    sendFrame(ws2, helloFrame({ clientId: 'slow-client-reconnected' }))
    const welcome2 = await nextFrame(ws2)
    expect(welcome2.type).toBe('studio_welcome')
    await closeSocket(ws2)
  })
})
