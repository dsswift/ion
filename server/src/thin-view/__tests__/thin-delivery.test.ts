/**
 * What a thin connection is sent, and what it is not.
 *
 *  - The view gate: a thin connection gets `studio:thin-event` and none of
 *    the raw engine stream or owner-published store syncs; a mirror
 *    connection gets those and never `studio:thin-event`.
 *  - The ownership rules a thin event is held to, by what it names: a tab, a
 *    directory, worktree state, or nothing.
 *  - `sendRemoteEvent` feeds the desktop_* transport and the thin channel
 *    from one call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type WebSocket from 'ws'

vi.mock('../../engine/engine-bridge-fs', () => ({
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: true, data: { version: '1.2.3' } })),
  getEnterprisePolicy: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('../../state', () => ({
  engineBridge: { connected: true },
  deviceFocusMap: new Map(),
  state: {},
}))

// First paint has its own test (thin-sync.test.ts); here it would only add
// frames this file then has to step around.
vi.mock('../thin-sync', () => ({ sendThinFirstPaint: vi.fn(() => Promise.resolve()), noteThinConnectionClosed: vi.fn() }))

import { startHarness, connectLocal, waitOpen, helloAndWelcome, closeSocket, resetConnectionRegistryForTest, type Harness } from '../../protocol/__tests__/harness'
import { publishStudioEvent } from '../../protocol/events'
import { _resetPrincipalIndexForTest } from '../../protocol/snapshot'
import { connectionRegistry } from '../../protocol/connection'
import { decodeFrame } from '@ion/shared/studio-wire/codec'
import { remoteClientsPresent, sendRemoteEvent } from '../remote-out'
import type { RemoteEvent } from '../../remote/protocol'

let harness: Harness
let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(async () => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-thin-delivery-'))
  process.env.ION_DATA_DIR = dataDir
  harness = await startHarness()
})

afterEach(async () => {
  await harness.close()
  resetConnectionRegistryForTest()
  _resetPrincipalIndexForTest()
  const { _resetCurrentServerConfigForTest } = await import('../../config/current')
  _resetCurrentServerConfigForTest()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function writeTabs(tabs: unknown[]): void {
  writeFileSync(join(dataDir, 'tabs.json'), JSON.stringify({ activeSessionId: null, tabs }))
}

interface Received { channel: string; payload: unknown }

/** Connect, hello with `view`, and collect every studio_event from then on. */
async function connect(clientId: string, view: 'mirror' | 'thin' | undefined): Promise<{ ws: WebSocket; events: Received[] }> {
  const ws = connectLocal(harness)
  await waitOpen(ws)
  await helloAndWelcome(ws, { clientId, clientKind: view === 'thin' ? 'mobile' : 'desktop', ...(view ? { view } : {}) })
  const events: Received[] = []
  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    const frame = decodeFrame(data.toString('utf-8'))
    if (frame.type === 'studio_event') events.push({ channel: frame.channel, payload: frame.payload })
  })
  return { ws, events }
}

function connFor(clientId: string) {
  const conn = connectionRegistry.findByClientId(clientId)
  if (!conn) throw new Error(`no connection for ${clientId}`)
  return conn
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 60))
}

const typeOf = (event: Received): unknown => (event.payload as { type?: unknown } | null)?.type
/** Every connect republishes presence, which reaches thin connections as `desktop_presence`; it is not what these tests are about. */
const withoutPresence = (events: Received[]): Received[] => events.filter((e) => typeOf(e) !== 'desktop_presence')
const channelsOf = (events: Received[]): string[] => [...new Set(events.map((e) => e.channel))]
const typesOf = (events: Received[]): unknown[] => withoutPresence(events).map(typeOf)

describe('view gate', () => {
  it('a thin welcome carries an empty store and the connection records its view', async () => {
    writeTabs([{ id: 'tab-a', conversationId: null, title: 'A', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [] }])
    const ws = connectLocal(harness)
    await waitOpen(ws)
    const welcome = await helloAndWelcome(ws, { clientId: 'phone', clientKind: 'mobile', view: 'thin' })
    expect(welcome.snapshot.tabs).toEqual([])
    expect(welcome.snapshot.settings).toEqual({})
    expect(welcome.snapshot.automations).toEqual([])
    expect(connFor('phone').view).toBe('thin')
    expect(connFor('phone').clientKind).toBe('mobile')
    await closeSocket(ws)
  })

  it('a hello with no view is a mirror connection', async () => {
    const { ws } = await connect('desk', undefined)
    expect(connFor('desk').view).toBe('mirror')
    await closeSocket(ws)
  })

  it('a thin connection gets studio:thin-event and none of the mirror channels; a mirror connection gets the reverse', async () => {
    const thin = await connect('phone', 'thin')
    const mirror = await connect('desk', 'mirror')

    publishStudioEvent('ion:normalized-event', ['tab-a', { type: 'text_chunk', text: 'raw' }])
    publishStudioEvent('studio:tabs-sync', [{ revision: 1, tabs: [], activeTabIndex: null, liveTabStatus: {}, liveIsCompacting: {}, queuedAttachments: {} }])
    publishStudioEvent('studio:worktree-sync', [{ revision: 1, ready: true, inventory: {}, workspaces: {}, benchSourceTips: [], benchRetired: [], gitConflictAlerts: [], worktreePipeline: null, workspaceOperationLedger: [] }])
    publishStudioEvent('studio:conversation-terminals', [{ panes: [], openTabIds: [] }])
    publishStudioEvent('ion:settings-changed', [{}])
    publishStudioEvent('ion:projects-changed', [{}])
    sendRemoteEvent({ type: 'desktop_engine_profiles', profiles: [] } as RemoteEvent)
    await settle()

    expect(channelsOf(thin.events).sort()).toEqual(['ion:projects-changed', 'studio:thin-event'])
    expect(channelsOf(mirror.events)).not.toContain('studio:thin-event')
    expect(channelsOf(mirror.events)).toEqual(expect.arrayContaining(['ion:normalized-event', 'studio:tabs-sync', 'studio:worktree-sync', 'studio:conversation-terminals', 'ion:settings-changed', 'ion:projects-changed']))
    await closeSocket(thin.ws)
    await closeSocket(mirror.ws)
  })
})

describe('sendRemoteEvent', () => {
  it('feeds the thin channel, payload unchanged, whether or not it also rings', async () => {
    const thin = await connect('phone', 'thin')
    const event = { type: 'desktop_tab_status', tabId: 'tab-x', status: 'running' } as RemoteEvent
    sendRemoteEvent(event)
    sendRemoteEvent(event, true, { title: 't', body: 'b', tabId: 'tab-x' })
    await settle()
    expect(withoutPresence(thin.events).map((e) => e.payload)).toEqual([event, event])
    await closeSocket(thin.ws)
  })

  it('a push rings offline thin clients with the push fields the relay reads; a plain send rings nobody', async () => {
    const { setPushRinger } = await import('../push-doorbell')
    const ringer = vi.fn(() => 0)
    setPushRinger(ringer)
    try {
      const event = { type: 'desktop_notification', tabId: 'tab-x' } as unknown as RemoteEvent
      sendRemoteEvent(event)
      expect(ringer).not.toHaveBeenCalled()
      sendRemoteEvent(event, true, { title: 'Done', body: 'Build finished', tabId: 'tab-x', kind: 'briefing', resourceId: 'res-1' })
      expect(ringer).toHaveBeenCalledExactlyOnceWith(
        { pushTitle: 'Done', pushBody: 'Build finished', pushTabId: 'tab-x', notifyKind: 'briefing', notifyResourceId: 'res-1' },
        expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/),
      )
    } finally {
      setPushRinger(null)
    }
  })

  it('counts a thin connection as a client, and nothing else does', async () => {
    expect(remoteClientsPresent()).toBe(false)
    const thin = await connect('phone', 'thin')
    expect(remoteClientsPresent()).toBe(true)
    await closeSocket(thin.ws)
  })
})

describe('thin event ownership', () => {
  async function twoPrincipals() {
    writeTabs([
      { id: 'tab-a', conversationId: null, title: 'A', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'user:alice' },
      { id: 'tab-b', conversationId: null, title: 'B', customTitle: null, workingDirectory: '/b', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'user:bob' },
    ])
    // Isolated tenancy needs an identity provider to be configured; the two
    // principals are then forced on, as events.test.ts does.
    writeFileSync(join(dataDir, 'server.json'), JSON.stringify({ tenancy: { mode: 'isolated', unownedTabs: 'hidden' } }))
    const { _resetCurrentServerConfigForTest } = await import('../../config/current')
    _resetCurrentServerConfigForTest()
    const alice = await connect('alice-phone', 'thin')
    const bob = await connect('bob-phone', 'thin')
    const connA = connFor('alice-phone')
    const connB = connFor('bob-phone')
    connA.principal = { subject: 'user:alice', displayName: 'alice' }
    connB.principal = { subject: 'user:bob', displayName: 'bob' }
    return { alice, bob, connA, connB }
  }

  it('an event naming a tab, by tabId or by tab.id, reaches only the owner', async () => {
    const { alice, bob } = await twoPrincipals()
    sendRemoteEvent({ type: 'desktop_tab_status', tabId: 'tab-a', status: 'running' } as RemoteEvent)
    sendRemoteEvent({ type: 'desktop_tab_created', tab: { id: 'tab-b' } } as unknown as RemoteEvent)
    await settle()
    expect(typesOf(alice.events)).toEqual(['desktop_tab_status'])
    expect(typesOf(bob.events)).toEqual(['desktop_tab_created'])
    await closeSocket(alice.ws)
    await closeSocket(bob.ws)
  })

  it('git state for a directory reaches only a connection whose own tabs live there', async () => {
    const { alice, bob, connA, connB } = await twoPrincipals()
    connA.thinDirectories = new Set(['/a'])
    connB.thinDirectories = new Set(['/b'])
    sendRemoteEvent({ type: 'desktop_git_changes_response', directory: '/a', files: [], branch: 'main', isGitRepo: true, ahead: 0, behind: 0, stagedCount: 0, unstagedCount: 0 } as unknown as RemoteEvent)
    await settle()
    expect(typesOf(alice.events)).toEqual(['desktop_git_changes_response'])
    expect(typesOf(bob.events)).toEqual([])
    await closeSocket(alice.ws)
    await closeSocket(bob.ws)
  })

  it('worktree state needs git:write, and an event naming nothing reaches everyone', async () => {
    const { alice, bob, connA, connB } = await twoPrincipals()
    connA.scopes = ['conversations:read', 'git:write']
    connB.scopes = ['conversations:read']
    sendRemoteEvent({ type: 'desktop_worktree_state', states: [] } as RemoteEvent)
    sendRemoteEvent({ type: 'desktop_engine_profiles', profiles: [] } as RemoteEvent)
    await settle()
    expect(typesOf(alice.events)).toEqual(['desktop_worktree_state', 'desktop_engine_profiles'])
    expect(typesOf(bob.events)).toEqual(['desktop_engine_profiles'])
    await closeSocket(alice.ws)
    await closeSocket(bob.ws)
  })
})
