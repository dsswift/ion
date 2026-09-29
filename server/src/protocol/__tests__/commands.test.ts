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
import { send, StudioRequiredError, _resetPendingCommandsForTest } from '../commands'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

let harness: Harness
let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(async () => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-studio-wire-commands-data-'))
  process.env.ION_DATA_DIR = dataDir
  harness = await startHarness()
})

afterEach(async () => {
  await harness.close()
  resetConnectionRegistryForTest()
  _resetPendingCommandsForTest()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

describe('reverse studio_command routing', () => {
  it('routes graph.fit to the connection advertising the graph capability and returns its result', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ capabilities: ['graph'] }))
    const welcome = await nextFrame(ws)
    expect(welcome.type).toBe('studio_welcome')

    const commandPromise = send(connectionRegistry, 'env-test', 'graph.fit', {}, 1000)

    const commandFrame = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_command' }>
    expect(commandFrame.type).toBe('studio_command')
    expect(commandFrame.command).toBe('graph.fit')

    sendFrame(ws, { type: 'studio_command_result', id: commandFrame.id, ok: true, value: { fitted: true } })

    await expect(commandPromise).resolves.toEqual({ fitted: true })
    await closeSocket(ws)
  })

  it('rejects with StudioRequiredError when no connection advertises the capability', async () => {
    await expect(send(connectionRegistry, 'env-test', 'browser.click', { selector: '#x' }, 1000)).rejects.toBeInstanceOf(StudioRequiredError)
  })

  it('rejects when the connection replies ok:false', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ capabilities: ['browser'] }))
    const welcome = await nextFrame(ws)
    expect(welcome.type).toBe('studio_welcome')

    const commandPromise = send(connectionRegistry, 'env-test', 'browser.click', { selector: '#missing' }, 1000)
    const commandFrame = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_command' }>
    sendFrame(ws, { type: 'studio_command_result', id: commandFrame.id, ok: false, error: 'element not found' })

    await expect(commandPromise).rejects.toThrow('element not found')
    await closeSocket(ws)
  })

  it('rejects on timeout when no result arrives', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ capabilities: ['graph'] }))
    const welcome = await nextFrame(ws)
    expect(welcome.type).toBe('studio_welcome')

    await expect(send(connectionRegistry, 'env-test', 'graph.fit', {}, 30)).rejects.toThrow(/timed out/)
    await closeSocket(ws)
  })
})
