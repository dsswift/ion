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
import { publishStudioEvent } from '../events'
import { _resetPrincipalIndexForTest } from '../snapshot'

let harness: Harness
let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(async () => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-studio-wire-events-data-'))
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

describe('studio_event: per-principal filtering', () => {
  it('delivers a tab-scoped event only to the connection whose principal owns that tab, and environment-wide events to both', async () => {
    writeTabs([
      { id: 'tab-a', conversationId: null, title: 'A', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:alice' },
      { id: 'tab-b', conversationId: null, title: 'B', customTitle: null, workingDirectory: '/b', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:bob' },
    ])

    // Both connections authenticate through the SAME AuthPolicy (this
    // child's LocalOnlyAuthPolicy only ever resolves the local principal),
    // then have distinct principals forced onto them post-hello so the
    // filter has two real subjects to distinguish — the filtering logic in
    // events.ts reads `conn.principal.subject` at publish time, so this
    // exercises the real code path without needing a second identity
    // provider (out of scope until child 08, server-auth).
    const wsA = connectLocal(harness)
    await waitOpen(wsA)
    sendFrame(wsA, helloFrame({ clientId: 'client-a' }))
    const welcomeA = await nextFrame(wsA)
    expect(welcomeA.type).toBe('studio_welcome')

    const wsB = connectLocal(harness)
    await waitOpen(wsB)
    sendFrame(wsB, helloFrame({ clientId: 'client-b' }))
    const welcomeB = await nextFrame(wsB)
    expect(welcomeB.type).toBe('studio_welcome')

    const { connectionRegistry } = await import('../connection')
    const [connA, connB] = connectionRegistry.all()
    connA.principal = { subject: 'local:alice', displayName: 'alice' }
    connB.principal = { subject: 'local:bob', displayName: 'bob' }

    const framesA: { type: string; channel?: string }[] = []
    const framesB: { type: string; channel?: string }[] = []
    wsA.on('message', (data, isBinary) => {
      if (!isBinary) framesA.push(JSON.parse((data as Buffer).toString('utf-8')))
    })
    wsB.on('message', (data, isBinary) => {
      if (!isBinary) framesB.push(JSON.parse((data as Buffer).toString('utf-8')))
    })

    publishStudioEvent('ion:tab-status-change', ['tab-a', 'working', 'idle'])
    publishStudioEvent('ion:settings-changed', [{ theme: 'dark' }])

    await new Promise((resolve) => setTimeout(resolve, 100))

    const aTabEvents = framesA.filter((f) => f.type === 'studio_event' && f.channel === 'ion:tab-status-change')
    const bTabEvents = framesB.filter((f) => f.type === 'studio_event' && f.channel === 'ion:tab-status-change')
    expect(aTabEvents).toHaveLength(1)
    expect(bTabEvents).toHaveLength(0)

    const aEnvEvents = framesA.filter((f) => f.type === 'studio_event' && f.channel === 'ion:settings-changed')
    const bEnvEvents = framesB.filter((f) => f.type === 'studio_event' && f.channel === 'ion:settings-changed')
    expect(aEnvEvents).toHaveLength(1)
    expect(bEnvEvents).toHaveLength(1)

    await closeSocket(wsA)
    await closeSocket(wsB)
  })

  it('delivers a Provider Subscription snapshot only to the person it names, and a broadcast one to everyone, with no owner on the wire', async () => {
    const wsA = connectLocal(harness)
    await waitOpen(wsA)
    sendFrame(wsA, helloFrame({ clientId: 'client-sub-a' }))
    expect((await nextFrame(wsA)).type).toBe('studio_welcome')
    const wsB = connectLocal(harness)
    await waitOpen(wsB)
    sendFrame(wsB, helloFrame({ clientId: 'client-sub-b' }))
    expect((await nextFrame(wsB)).type).toBe('studio_welcome')

    const { connectionRegistry } = await import('../connection')
    const [connA, connB] = connectionRegistry.all()
    connA.principal = { subject: 'local:alice', displayName: 'alice' }
    connB.principal = { subject: 'local:bob', displayName: 'bob' }

    const framesA: { type: string; channel?: string; payload?: unknown }[] = []
    const framesB: { type: string; channel?: string; payload?: unknown }[] = []
    wsA.on('message', (data, isBinary) => { if (!isBinary) framesA.push(JSON.parse((data as Buffer).toString('utf-8'))) })
    wsB.on('message', (data, isBinary) => { if (!isBinary) framesB.push(JSON.parse((data as Buffer).toString('utf-8'))) })

    const alices = { state: 'selection_required', options: [{ id: 'a', label: 'A' }] }
    publishStudioEvent('ion:provider-subscription-changed', [alices, 'local:alice'])
    publishStudioEvent('ion:provider-subscription-changed', [{ state: 'applied' }])
    await new Promise((resolve) => setTimeout(resolve, 100))

    const pick = (frames: typeof framesA) => frames.filter((f) => f.type === 'studio_event' && f.channel === 'ion:provider-subscription-changed')
    expect(pick(framesA).map((f) => f.payload)).toEqual([alices, { state: 'applied' }])
    expect(pick(framesB).map((f) => f.payload)).toEqual([{ state: 'applied' }])

    await closeSocket(wsA)
    await closeSocket(wsB)
  })

  it('FR-02: shared tenancy delivers a tab-scoped event to every connection regardless of tab ownership', async () => {
    const { setCurrentServerConfig, currentServerConfig } = await import('../../config/current')
    setCurrentServerConfig({ ...currentServerConfig(), tenancy: { mode: 'shared' } })

    writeTabs([
      { id: 'tab-a', conversationId: null, title: 'A', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:alice' },
      { id: 'tab-b', conversationId: null, title: 'B', customTitle: null, workingDirectory: '/b', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:bob' },
    ])

    const wsA = connectLocal(harness)
    await waitOpen(wsA)
    sendFrame(wsA, helloFrame({ clientId: 'client-shared-a' }))
    expect((await nextFrame(wsA)).type).toBe('studio_welcome')

    const wsB = connectLocal(harness)
    await waitOpen(wsB)
    sendFrame(wsB, helloFrame({ clientId: 'client-shared-b' }))
    expect((await nextFrame(wsB)).type).toBe('studio_welcome')

    const { connectionRegistry } = await import('../connection')
    const [connA, connB] = connectionRegistry.all()
    connA.principal = { subject: 'local:alice', displayName: 'alice' }
    connB.principal = { subject: 'local:bob', displayName: 'bob' }

    const framesB: { type: string; channel?: string }[] = []
    wsB.on('message', (data, isBinary) => {
      if (!isBinary) framesB.push(JSON.parse((data as Buffer).toString('utf-8')))
    })

    publishStudioEvent('ion:tab-status-change', ['tab-a', 'working', 'idle'])
    await new Promise((resolve) => setTimeout(resolve, 100))

    const bTabEvents = framesB.filter((f) => f.type === 'studio_event' && f.channel === 'ion:tab-status-change')
    expect(bTabEvents).toHaveLength(1)

    await closeSocket(wsA)
    await closeSocket(wsB)
  })

  it('gates a reclassified mirror-sync tab channel (studio:active-tab) the same as any other tab-scoped channel', async () => {
    writeTabs([
      { id: 'tab-a', conversationId: null, title: 'A', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:alice' },
      { id: 'tab-b', conversationId: null, title: 'B', customTitle: null, workingDirectory: '/b', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:bob' },
    ])

    const wsA = connectLocal(harness)
    await waitOpen(wsA)
    sendFrame(wsA, helloFrame({ clientId: 'client-a2' }))
    expect((await nextFrame(wsA)).type).toBe('studio_welcome')

    const wsB = connectLocal(harness)
    await waitOpen(wsB)
    sendFrame(wsB, helloFrame({ clientId: 'client-b2' }))
    expect((await nextFrame(wsB)).type).toBe('studio_welcome')

    const { connectionRegistry } = await import('../connection')
    const [connA, connB] = connectionRegistry.all()
    connA.principal = { subject: 'local:alice', displayName: 'alice' }
    connB.principal = { subject: 'local:bob', displayName: 'bob' }

    const framesA: { type: string; channel?: string }[] = []
    const framesB: { type: string; channel?: string }[] = []
    wsA.on('message', (data, isBinary) => { if (!isBinary) framesA.push(JSON.parse((data as Buffer).toString('utf-8'))) })
    wsB.on('message', (data, isBinary) => { if (!isBinary) framesB.push(JSON.parse((data as Buffer).toString('utf-8'))) })

    publishStudioEvent('studio:active-tab', ['tab-a'])
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(framesA.filter((f) => f.channel === 'studio:active-tab')).toHaveLength(1)
    expect(framesB.filter((f) => f.channel === 'studio:active-tab')).toHaveLength(0)

    await closeSocket(wsA)
    await closeSocket(wsB)
  })

  it('projects a per-principal mirror-sync channel (studio:tabs-sync) down to each connection\'s own tabs, never broadcasting the other principal\'s', async () => {
    writeTabs([
      { id: 'tab-a', conversationId: null, title: 'A', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:alice' },
      { id: 'tab-b', conversationId: null, title: 'B', customTitle: null, workingDirectory: '/b', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:bob' },
    ])

    const wsA = connectLocal(harness)
    await waitOpen(wsA)
    sendFrame(wsA, helloFrame({ clientId: 'client-a3' }))
    expect((await nextFrame(wsA)).type).toBe('studio_welcome')

    const { connectionRegistry } = await import('../connection')
    const [connA] = connectionRegistry.all()
    connA.principal = { subject: 'local:alice', displayName: 'alice' }

    const framesA: { type: string; channel?: string; payload?: unknown }[] = []
    wsA.on('message', (data, isBinary) => { if (!isBinary) framesA.push(JSON.parse((data as Buffer).toString('utf-8'))) })

    publishStudioEvent('studio:tabs-sync', [{
      schemaVersion: 4,
      activeSessionId: null,
      activeTabIndex: null,
      tabs: [
        { id: 'tab-a', conversationId: null, title: 'A', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [] },
        { id: 'tab-b', conversationId: null, title: 'B', customTitle: null, workingDirectory: '/b', hasChosenDirectory: true, additionalDirs: [] },
      ],
      revision: 1,
      liveTabStatus: { 'tab-a': 'idle', 'tab-b': 'idle' },
      liveIsCompacting: {},
      queuedAttachments: {},
    }])
    await new Promise((resolve) => setTimeout(resolve, 100))

    const syncFrames = framesA.filter((f) => f.channel === 'studio:tabs-sync')
    expect(syncFrames).toHaveLength(1)
    const payload = syncFrames[0].payload as { tabs: Array<{ id: string }> }
    expect(payload.tabs.map((t) => t.id)).toEqual(['tab-a'])

    await closeSocket(wsA)
  })

  it('does not fan out a channel outside the wire contract', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame())
    const welcome = await nextFrame(ws)
    expect(welcome.type).toBe('studio_welcome')

    const frames: unknown[] = []
    ws.on('message', (data, isBinary) => {
      if (!isBinary) frames.push(JSON.parse((data as Buffer).toString('utf-8')))
    })

    publishStudioEvent('ion:some-desktop-only-channel', ['whatever'])
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(frames).toHaveLength(0)
    await closeSocket(ws)
  })
})

describe('studio_event: startup progress replay on attach', () => {
  it('hands a connection that attaches mid-restore the current phase, and a late one the terminal report', async () => {
    const { reportStartup, _resetStartupSequenceForTest } = await import('../../store/startup-progress')
    _resetStartupSequenceForTest()
    // Restoration began before any client attached: these reports reached nobody.
    reportStartup('Loading saved tabs…')
    reportStartup('Restoring tab 3 of 12…')

    const ws = connectLocal(harness)
    await waitOpen(ws)
    const frames: { type: string; channel?: string; payload?: unknown }[] = []
    ws.on('message', (data, isBinary) => {
      if (!isBinary) frames.push(JSON.parse((data as Buffer).toString('utf-8')))
    })
    sendFrame(ws, helloFrame({ clientId: 'late-splash' }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    const replay = frames.find((f) => f.type === 'studio_event' && f.channel === 'startup:progress')
    // Bare object, the same shape a live `broadcast(channel, report)` takes
    // through formatEventPayload -- the desktop validates both with one rule.
    expect(replay?.payload).toEqual({ source: 'server', sequence: 1, status: 'Restoring tab 3 of 12…', ready: false })

    // A small workspace restores before the desktop's wire opens. The
    // desktop reveals its window only once this report has reached it, so
    // withholding the terminal report from a late attacher left that splash
    // up forever.
    reportStartup('Workspace ready', true)
    const ws2 = connectLocal(harness)
    await waitOpen(ws2)
    const frames2: { type: string; channel?: string; payload?: unknown }[] = []
    ws2.on('message', (data, isBinary) => {
      if (!isBinary) frames2.push(JSON.parse((data as Buffer).toString('utf-8')))
    })
    sendFrame(ws2, helloFrame({ clientId: 'on-time' }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    const late = frames2.find((f) => f.type === 'studio_event' && f.channel === 'startup:progress')
    expect(late?.payload).toEqual({ source: 'server', sequence: 2, status: 'Workspace ready', ready: true })
    closeSocket(ws)
    closeSocket(ws2)
    _resetStartupSequenceForTest()
  })
})
