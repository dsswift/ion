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
  enterprisePolicyCache: { policy: null },
}))

import { startHarness, connectLocal, waitOpen, sendFrame, nextFrame, helloFrame, closeSocket, resetConnectionRegistryForTest, type Harness } from './harness'
import { connectionRegistry } from '../connection'
import { useSessionStore } from '../../store/sessionStore'
import { _resetPrincipalIndexForTest } from '../tabs-index'
import { _resetCurrentServerConfigForTest, currentServerConfig, setCurrentServerConfig } from '../../config/current'
import type { ServerOidcConfig } from '../../config/server-config'
import type { StudioFrame } from '@ion/shared/studio-wire/types'

const oidc: ServerOidcConfig = {
  issuer: 'https://issuer.example.org',
  audience: 'ion-server',
  scope: 'api://ion-server/.default',
  clientId: 'browser-client',
  rolesToScopes: {},
  defaultScopes: [],
  allowedSubjects: [],
    clientSecret: '',
}

let harness: Harness
let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(async () => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-studio-wire-actions-data-'))
  process.env.ION_DATA_DIR = dataDir
  harness = await startHarness()
})

afterEach(async () => {
  await harness.close()
  resetConnectionRegistryForTest()
  _resetPrincipalIndexForTest()
  _resetCurrentServerConfigForTest()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function writeTabs(tabs: unknown[], settledHistory: unknown[] = []): void {
  writeFileSync(join(dataDir, 'tabs.json'), JSON.stringify({ activeSessionId: null, tabs, settledHistory }))
}

async function connectAndWelcome() {
  const ws = connectLocal(harness)
  await waitOpen(ws)
  sendFrame(ws, helloFrame())
  const welcome = await nextFrame(ws)
  expect(welcome.type).toBe('studio_welcome')
  const conn = connectionRegistry.all()[0]
  return { ws, conn }
}

describe('studio_action: scope enforcement', () => {
  it('runs a conversations:operate action for a connection with that scope and replies ok:true', async () => {
    const { ws } = await connectAndWelcome()
    const tabId = useSessionStore.getState().tabs[0]?.id ?? 'no-tabs-in-this-test-store'
    sendFrame(ws, { type: 'studio_action', id: 'act-1', action: 'clearAttachments', args: [] })
    const result = await nextFrame(ws)
    expect(result).toMatchObject({ type: 'studio_action_result', id: 'act-1', ok: true })
    void tabId
    await closeSocket(ws)
  })

  it('refuses an action when the connection lacks the required scope', async () => {
    const { ws, conn } = await connectAndWelcome()
    conn.scopes = ['conversations:read']
    sendFrame(ws, { type: 'studio_action', id: 'act-2', action: 'runInTerminal', args: ['tab-1', 'echo hi'] })
    const result = await nextFrame(ws)
    expect(result).toEqual({
      type: 'studio_action_result',
      id: 'act-2',
      ok: false,
      refusal: { code: 'scope', message: 'runInTerminal requires scope terminal:operate' },
    })
    await closeSocket(ws)
  })

  it('rejects an unregistered action name', async () => {
    const { ws } = await connectAndWelcome()
    sendFrame(ws, { type: 'studio_action', id: 'act-3', action: 'notARealAction', args: [] })
    const result = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_action_result' }>
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('unknown_action')
    await closeSocket(ws)
  })

  it('rejects an argument shape that fails the action spec', async () => {
    const { ws } = await connectAndWelcome()
    // clearTab takes exactly zero args; sending one must fail validation, not run the action.
    sendFrame(ws, { type: 'studio_action', id: 'act-4', action: 'clearTab', args: ['unexpected-arg'] })
    const result = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_action_result' }>
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('invalid_args')
    await closeSocket(ws)
  })
})

describe('studio_action: tab ownership enforcement (A2)', () => {
  it('refuses a tabId-bearing mirror-store action against another principal\'s tab', async () => {
    writeTabs([
      { id: 'tab-alice', conversationId: null, title: 'Alice', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:alice' },
      { id: 'tab-bob', conversationId: null, title: 'Bob', customTitle: null, workingDirectory: '/b', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:bob' },
    ])
    const { ws, conn } = await connectAndWelcome()
    conn.principal = { subject: 'local:alice', displayName: 'alice' }

    sendFrame(ws, { type: 'studio_action', id: 'act-own-1', action: 'renameTab', args: ['tab-bob', 'hijacked'] })
    const result = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_action_result' }>
    expect(result.ok).toBe(false)
    expect(result.refusal?.code).toBe('ownership')
    await closeSocket(ws)
  })

  it('allows the same action against the connection\'s own tab', async () => {
    writeTabs([
      { id: 'tab-alice', conversationId: null, title: 'Alice', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:alice' },
    ])
    const { ws, conn } = await connectAndWelcome()
    conn.principal = { subject: 'local:alice', displayName: 'alice' }

    sendFrame(ws, { type: 'studio_action', id: 'act-own-2', action: 'renameTab', args: ['tab-alice', 'my own tab'] })
    const result = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_action_result' }>
    expect(result.ok).toBe(true)
    await closeSocket(ws)
  })

  it('FR-02: shared tenancy allows the action against another principal\'s tab', async () => {
    setCurrentServerConfig({ ...currentServerConfig(), tenancy: { mode: 'shared' } })
    writeTabs([
      { id: 'tab-alice', conversationId: null, title: 'Alice', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:alice' },
      { id: 'tab-bob', conversationId: null, title: 'Bob', customTitle: null, workingDirectory: '/b', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:bob' },
    ])
    const { ws, conn } = await connectAndWelcome()
    conn.principal = { subject: 'local:alice', displayName: 'alice' }

    sendFrame(ws, { type: 'studio_action', id: 'act-own-shared', action: 'renameTab', args: ['tab-bob', 'shared tenancy'] })
    const result = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_action_result' }>
    expect(result.ok).toBe(true)
    await closeSocket(ws)
  })

  it('leaves an action that names no tab unaffected', async () => {
    const { ws } = await connectAndWelcome()
    sendFrame(ws, { type: 'studio_action', id: 'act-own-3', action: 'clearAttachments', args: [] })
    const result = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_action_result' }>
    expect(result.ok).toBe(true)
    await closeSocket(ws)
  })
})

describe('studio_action: settings_locked refusal (Task 10)', () => {
  it('refuses a server-configuration mutation by SCOPE, not by transport', async () => {
    const { ws, conn } = await connectAndWelcome()
    // The harness's LocalOnlyAuthPolicy only ever accepts a `local`
    // credential on the `local` transport, so a real non-local connection
    // can't authenticate here at all -- mutating the fields directly is the
    // established pattern (see connA.principal = {...} in events.test.ts)
    // for exercising a check that reads Connection fields the harness
    // itself has no door to produce.
    ;(conn as unknown as { transport: string }).transport = 'tcp'
    ;(conn as unknown as { scopes: string[] }).scopes = ['conversations:read', 'conversations:operate']

    sendFrame(ws, { type: 'studio_action', id: 'act-lock-1', action: 'model.setTier', args: ['tier-1'] })
    const result = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_action_result' }>
    expect(result.ok).toBe(false)
    // Who administers a server is the `admin` grant. The transport a
    // connection arrived on no longer locks anything.
    expect(result.refusal?.code).toBe('scope')

    await closeSocket(ws)
  })

  it('does not lock a read-only sibling action for a non-local connection', async () => {
    const { ws, conn } = await connectAndWelcome()
    ;(conn as unknown as { transport: string }).transport = 'tcp'

    sendFrame(ws, { type: 'studio_action', id: 'act-lock-2', action: 'renameTab', args: [useSessionStore.getState().tabs[0]?.id ?? 'no-tab', 'x'] })
    const result = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_action_result' }>
    expect(result.refusal?.code).not.toBe('settings_locked')

    await closeSocket(ws)
  })

  it('does not lock a lockable action for a local connection with no enterprise config', async () => {
    const { ws } = await connectAndWelcome()

    sendFrame(ws, { type: 'studio_action', id: 'act-lock-3', action: 'provider.setDefault', args: ['anthropic'] })
    const result = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_action_result' }>
    expect(result.refusal?.code).not.toBe('settings_locked')

    await closeSocket(ws)
  })
})

describe('studio_action: session.* conversation ownership enforcement (A2b)', () => {
  it('refuses session.getConversation against another principal\'s conversation', async () => {
    writeTabs([
      { id: 'tab-alice', conversationId: 'conv-alice', title: 'Alice', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:alice' },
      { id: 'tab-bob', conversationId: 'conv-bob', title: 'Bob', customTitle: null, workingDirectory: '/b', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:bob' },
    ])
    const { ws, conn } = await connectAndWelcome()
    conn.principal = { subject: 'local:alice', displayName: 'alice' }

    sendFrame(ws, { type: 'studio_action', id: 'act-conv-1', action: 'session.getConversation', args: [{ conversationId: 'conv-bob' }] })
    const result = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_action_result' }>
    expect(result.ok).toBe(false)
    expect(result.refusal?.code).toBe('ownership')
    await closeSocket(ws)
  })

  it('allows session.getConversation against the connection\'s own conversation', async () => {
    writeTabs([
      { id: 'tab-alice', conversationId: 'conv-alice', title: 'Alice', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:alice' },
    ])
    const { ws, conn } = await connectAndWelcome()
    conn.principal = { subject: 'local:alice', displayName: 'alice' }

    sendFrame(ws, { type: 'studio_action', id: 'act-conv-2', action: 'session.getConversation', args: [{ conversationId: 'conv-alice' }] })
    const result = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_action_result' }>
    expect(result.ok).toBe(true)
    await closeSocket(ws)
  })

  it('refuses session.deleteStored when ANY id in the batch belongs to another principal', async () => {
    writeTabs([], [
      { id: 'tab-alice-closed', conversationId: 'conv-alice', title: 'Alice', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:alice' },
      { id: 'tab-bob-closed', conversationId: 'conv-bob', title: 'Bob', customTitle: null, workingDirectory: '/b', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:bob' },
    ])
    const { ws, conn } = await connectAndWelcome()
    conn.principal = { subject: 'local:alice', displayName: 'alice' }

    sendFrame(ws, { type: 'studio_action', id: 'act-del-1', action: 'session.deleteStored', args: [['conv-alice', 'conv-bob']] })
    const result = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_action_result' }>
    expect(result.ok).toBe(false)
    expect(result.refusal?.code).toBe('ownership')
    await closeSocket(ws)
  })

  it('lets session.deleteStored reach the handler when every id is the connection\'s own', async () => {
    writeTabs([], [
      { id: 'tab-alice-closed', conversationId: 'conv-alice', title: 'Alice', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:alice' },
    ])
    const { ws, conn } = await connectAndWelcome()
    conn.principal = { subject: 'local:alice', displayName: 'alice' }

    sendFrame(ws, { type: 'studio_action', id: 'act-del-2', action: 'session.deleteStored', args: [['conv-alice']] })
    const result = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_action_result' }>
    // The engine bridge isn't wired in this test's mock, so the handler
    // itself may still fail -- what this pins is that ownership did NOT
    // block it (no `refusal.code === 'ownership'`), unlike the batch above.
    expect(result.refusal?.code).not.toBe('ownership')
    await closeSocket(ws)
  })

  it('refuses session.loadTranscript against another principal\'s tab (reuses the tab-ownership mechanism, not the conversation one)', async () => {
    writeTabs([
      { id: 'tab-bob', conversationId: 'conv-bob', title: 'Bob', customTitle: null, workingDirectory: '/b', hasChosenDirectory: true, additionalDirs: [], principalSubject: 'local:bob' },
    ])
    const { ws, conn } = await connectAndWelcome()
    conn.principal = { subject: 'local:alice', displayName: 'alice' }

    sendFrame(ws, { type: 'studio_action', id: 'act-transcript-1', action: 'session.loadTranscript', args: ['tab-bob'] })
    const result = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_action_result' }>
    expect(result.ok).toBe(false)
    expect(result.refusal?.code).toBe('ownership')
    await closeSocket(ws)
  })

  it('session.list/session.listAll no longer exist (removed with the disconnected History Picker; unpartitioned ~/.claude/projects had no id to own anyway)', async () => {
    const { ws } = await connectAndWelcome()
    for (const action of ['session.list', 'session.listAll']) {
      sendFrame(ws, { type: 'studio_action', id: `act-removed-${action}`, action, args: [] })
      const result = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_action_result' }>
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('unknown_action')
    }
    await closeSocket(ws)
  })

  it('leaves session.load unaffected (no id to own; it loads one conversation the caller already names elsewhere)', async () => {
    const { ws } = await connectAndWelcome()
    sendFrame(ws, { type: 'studio_action', id: 'act-list-2', action: 'session.load', args: ['any-session-id'] })
    const load = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_action_result' }>
    expect(load.refusal?.code).not.toBe('ownership')
    await closeSocket(ws)
  })

  it('multi-tenant: an unresolvable conversation id refuses rather than falling open', async () => {
    setCurrentServerConfig({ ...currentServerConfig(), oidc })
    const { ws, conn } = await connectAndWelcome()
    conn.principal = { subject: 'local:alice', displayName: 'alice' }

    sendFrame(ws, { type: 'studio_action', id: 'act-mt-1', action: 'session.getConversation', args: [{ conversationId: 'conv-nobody-knows' }] })
    const result = (await nextFrame(ws)) as Extract<StudioFrame, { type: 'studio_action_result' }>
    expect(result.ok).toBe(false)
    expect(result.refusal?.code).toBe('ownership')
    await closeSocket(ws)
  })
})
