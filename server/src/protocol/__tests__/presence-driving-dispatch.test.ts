/**
 * FR-02: `submitRemotePrompt` is the one mirror-store action that starts a
 * run, so `handleAction` (`actions.ts`) marks the tab as driven by the
 * caller's subject before dispatching to the store -- see `presence.ts`'s
 * `setDriving`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
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
import type WebSocket from 'ws'
import { useSessionStore } from '../../store/sessionStore'
import { _resetPrincipalIndexForTest } from '../tabs-index'
import { _resetCurrentServerConfigForTest } from '../../config/current'
import { drivingMap, _resetPresenceForTest } from '../presence'

let harness: Harness
let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(async () => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-presence-driving-dispatch-'))
  process.env.ION_DATA_DIR = dataDir
  harness = await startHarness()
})

afterEach(async () => {
  await harness.close()
  resetConnectionRegistryForTest()
  _resetPrincipalIndexForTest()
  _resetCurrentServerConfigForTest()
  _resetPresenceForTest()
  vi.restoreAllMocks()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function writeTabs(tabs: unknown[]): void {
  writeFileSync(join(dataDir, 'tabs.json'), JSON.stringify({ activeSessionId: null, tabs }))
}

/**
 * A `studio_action` dispatch that also triggers a `setDriving()` broadcast
 * (e.g. `submitRemotePrompt`) can deliver the `studio_event` and the
 * `studio_action_result` back-to-back within the same socket read, so a
 * sequential `await nextFrame()` loop can miss the second frame in the gap
 * between resolving on the first and re-registering for the next. Collect
 * every frame with a persistent listener instead, matching the pattern in
 * events.test.ts.
 */
function collectFrames(ws: WebSocket): { type: string; id?: string; ok?: boolean }[] {
  const frames: { type: string; id?: string; ok?: boolean }[] = []
  ws.on('message', (data, isBinary) => {
    if (!isBinary) frames.push(JSON.parse((data as Buffer).toString('utf-8')))
  })
  return frames
}

async function connectAndWelcome() {
  const ws = connectLocal(harness)
  await waitOpen(ws)
  sendFrame(ws, helloFrame({ clientId: `client-${Math.random()}` }))
  expect((await nextFrame(ws)).type).toBe('studio_welcome')
  const { connectionRegistry } = await import('../connection')
  const conn = connectionRegistry.all()[connectionRegistry.all().length - 1]
  return { ws, conn }
}

describe('submitRemotePrompt marks the tab as driven', () => {
  it('records the caller as driving the named tab', async () => {
    writeTabs([{ id: 'tab-alice', conversationId: null, title: 'A', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:alice' }])
    vi.spyOn(useSessionStore.getState(), 'submitRemotePrompt').mockImplementation(() => undefined)

    const { ws, conn } = await connectAndWelcome()
    conn.principal = { subject: 'local:alice', displayName: 'alice' }
    const frames = collectFrames(ws)

    sendFrame(ws, { type: 'studio_action', id: 'act-drive-1', action: 'submitRemotePrompt', args: ['tab-alice', 'hello'] })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const result = frames.find((f) => f.type === 'studio_action_result' && f.id === 'act-drive-1')
    expect(result?.ok).toBe(true)
    expect(drivingMap()).toEqual({ 'tab-alice': 'local:alice' })

    await closeSocket(ws)
  })

  it('never marks driving for an action other than submitRemotePrompt', async () => {
    writeTabs([{ id: 'tab-alice', conversationId: null, title: 'A', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:alice' }])

    const { ws, conn } = await connectAndWelcome()
    conn.principal = { subject: 'local:alice', displayName: 'alice' }
    const frames = collectFrames(ws)

    sendFrame(ws, { type: 'studio_action', id: 'act-drive-2', action: 'renameTab', args: ['tab-alice', 'new title'] })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const result = frames.find((f) => f.type === 'studio_action_result' && f.id === 'act-drive-2')
    expect(result?.ok).toBe(true)
    expect(drivingMap()).toEqual({})

    await closeSocket(ws)
  })
})
