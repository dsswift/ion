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
import { graphCommandSender } from '../../studio-graph/renderer-bridge'
import { browserCommandSender } from '../../studio-playwright/renderer-bridge'
import { browserToolExecutor } from '../../studio-playwright/tool-executor'
import { _resetPendingCommandsForTest } from '../commands'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

let harness: Harness
let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(async () => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-studio-wire-senders-data-'))
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

describe('startStudioListeners: reverse-command sender registration', () => {
  it('installs a graph command sender backed by commands.send', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ capabilities: ['graph'] }))
    expect((await nextFrame(ws)).type).toBe('studio_welcome')

    const sender = graphCommandSender()
    expect(sender).not.toBeNull()

    const resultPromise = sender!({ kind: 'fit', conversationId: 'conv-1', cwd: '/repo' }, 1000)
    const commandFrame = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_command' }>
    expect(commandFrame.command).toBe('graph.fit')
    sendFrame(ws, { type: 'studio_command_result', id: commandFrame.id, ok: true, value: { callId: commandFrame.id, ok: true } })

    await expect(resultPromise).resolves.toEqual({ callId: commandFrame.id, ok: true })
    await closeSocket(ws)
  })

  it('installs a browser tool executor that sends browser.tool to the attached desktop', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ capabilities: ['browser'] }))
    expect((await nextFrame(ws)).type).toBe('studio_welcome')

    const run = browserToolExecutor()
    expect(run).not.toBeNull()

    const resultPromise = run!('browser_navigate', { url: 'https://x' }, { sessionKey: 'tab-1', cwd: '/repo', origin: 'model' })
    const commandFrame = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_command' }>
    expect(commandFrame.command).toBe('browser.tool')
    expect(commandFrame.args).toEqual({ name: 'browser_navigate', input: { url: 'https://x' }, ctx: { sessionKey: 'tab-1', cwd: '/repo', origin: 'model' } })
    sendFrame(ws, { type: 'studio_command_result', id: commandFrame.id, ok: true, value: { content: 'navigated', isError: false } })

    await expect(resultPromise).resolves.toEqual({ content: 'navigated', isError: false })
    await closeSocket(ws)
  })

  it('installs a browser command sender backed by commands.send', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ capabilities: ['browser'] }))
    expect((await nextFrame(ws)).type).toBe('studio_welcome')

    const sender = browserCommandSender()
    expect(sender).not.toBeNull()

    const resultPromise = sender!({ kind: 'status', conversationId: 'conv-1' }, 1000)
    const commandFrame = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_command' }>
    expect(commandFrame.command).toBe('browser.status')
    sendFrame(ws, { type: 'studio_command_result', id: commandFrame.id, ok: true, value: { callId: commandFrame.id, ok: true } })

    await expect(resultPromise).resolves.toEqual({ callId: commandFrame.id, ok: true })
    await closeSocket(ws)
  })
})
