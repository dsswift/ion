/**
 * An action that names no tab acts on the active one. A window holds tabs
 * from several environments, so it carries ITS active tab on the frame and
 * the server adopts that tab before the action runs; without it the action
 * fell on whichever conversation this server last had selected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../engine/engine-bridge-fs', () => ({
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: true, data: { version: '1.2.3' } })),
  getEnterprisePolicy: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('../../state', () => ({ engineBridge: { connected: true }, deviceFocusMap: new Map(), state: { remoteTransport: null } }))

import { startHarness, connectLocal, waitOpen, sendFrame, nextFrame, helloFrame, closeSocket, resetConnectionRegistryForTest, type Harness } from './harness'
import type WebSocket from 'ws'
import type { TabState } from '@ion/shared/types'
import { useSessionStore } from '../../store/sessionStore'
import { _resetPrincipalIndexForTest } from '../tabs-index'
import { _resetCurrentServerConfigForTest } from '../../config/current'

let harness: Harness
let dataDir: string
let originalIonDataDir: string | undefined
// The store copies its action functions into every new state object, so a
// spy installed on one state object rides along past `restoreAllMocks`. The
// real actions are captured once and put back after each test.
const realActions = { setPermissionMode: useSessionStore.getState().setPermissionMode, renameTab: useSessionStore.getState().renameTab }

const persisted = (id: string) => ({ id, conversationId: null, title: id, customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:alice' })

beforeEach(async () => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-active-tab-action-'))
  process.env.ION_DATA_DIR = dataDir
  writeFileSync(join(dataDir, 'tabs.json'), JSON.stringify({ activeSessionId: null, tabs: [persisted('tab-a'), persisted('tab-b')] }))
  harness = await startHarness()
  useSessionStore.setState({ tabs: [{ id: 'tab-a' }, { id: 'tab-b' }] as unknown as TabState[], activeTabId: 'tab-a' })
})

afterEach(async () => {
  useSessionStore.setState(realActions)
  await harness.close()
  resetConnectionRegistryForTest()
  _resetPrincipalIndexForTest()
  _resetCurrentServerConfigForTest()
  vi.restoreAllMocks()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function collect(ws: WebSocket): Array<{ type: string; id?: string; ok?: boolean; error?: { code?: string } }> {
  const frames: Array<{ type: string; id?: string; ok?: boolean; error?: { code?: string } }> = []
  ws.on('message', (data, isBinary) => { if (!isBinary) frames.push(JSON.parse((data as Buffer).toString('utf-8'))) })
  return frames
}

async function connect(): Promise<WebSocket> {
  const ws = connectLocal(harness)
  await waitOpen(ws)
  sendFrame(ws, helloFrame({ clientId: `client-${Math.random()}` }))
  expect((await nextFrame(ws)).type).toBe('studio_welcome')
  const { connectionRegistry } = await import('../connection')
  connectionRegistry.all()[connectionRegistry.all().length - 1].principal = { subject: 'local:alice', displayName: 'alice' }
  return ws
}

describe('studio_action.activeTabId', () => {
  it('makes the named tab active before an active-tab action runs', async () => {
    let activeAtCall: string | undefined
    const ws = await connect()
    // Spied after the handshake, which may itself touch the store.
    useSessionStore.setState({ activeTabId: 'tab-a' })
    vi.spyOn(useSessionStore.getState(), 'setPermissionMode').mockImplementation(() => { activeAtCall = useSessionStore.getState().activeTabId })
    const frames = collect(ws)
    sendFrame(ws, { type: 'studio_action', id: 'a1', action: 'setPermissionMode', args: ['auto'], activeTabId: 'tab-b' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(frames.find((f) => f.id === 'a1')?.ok).toBe(true)
    expect(activeAtCall).toBe('tab-b')
    await closeSocket(ws)
  })

  it('refuses when this server has no such tab, and the action never runs', async () => {
    const ws = await connect()
    useSessionStore.setState({ activeTabId: 'tab-a' })
    const spy = vi.spyOn(useSessionStore.getState(), 'setPermissionMode').mockImplementation(() => undefined)
    const frames = collect(ws)
    sendFrame(ws, { type: 'studio_action', id: 'a2', action: 'setPermissionMode', args: ['auto'], activeTabId: 'tab-on-another-machine' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const result = frames.find((f) => f.id === 'a2')
    expect(result?.ok).toBe(false)
    expect(result?.error?.code).toBe('unknown_tab')
    expect(spy).not.toHaveBeenCalled()
    expect(useSessionStore.getState().activeTabId).toBe('tab-a')
    await closeSocket(ws)
  })

  it('an action that names its own tab ignores the field', async () => {
    const ws = await connect()
    useSessionStore.setState({ activeTabId: 'tab-a' })
    const spy = vi.spyOn(useSessionStore.getState(), 'renameTab').mockImplementation(() => undefined)
    const frames = collect(ws)
    sendFrame(ws, { type: 'studio_action', id: 'a3', action: 'renameTab', args: ['tab-a', 'x'], activeTabId: 'tab-b' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(frames.find((f) => f.id === 'a3')?.ok).toBe(true)
    expect(spy).toHaveBeenCalled()
    expect(useSessionStore.getState().activeTabId).toBe('tab-a')
    await closeSocket(ws)
  })
})
