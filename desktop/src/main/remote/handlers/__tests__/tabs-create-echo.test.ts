/**
 * tabs-create-echo.test.ts
 *
 * RC1 pin: the `desktop_tab_created` echo must be DETERMINISTIC, not a race
 * against a debounced renderer push.
 *
 * The old implementation waited a hardcoded 500ms, then read
 * `getRemoteTabStates()` — which serves any cache younger than 10s WITHOUT
 * checking whether it contains the tab being asked about — and returned
 * silently when the lookup missed. That silence cost ~4s of visible latency on
 * every iOS tab create: the client's confirm-or-resend timeout was the only
 * recovery.
 *
 * These tests pin the three properties that fix it:
 *   1. the echo lands with NO timer advance (no 500ms floor),
 *   2. the projection is force-refreshed before the lookup, so a stale-but-
 *      "fresh" cache cannot hide a just-created tab,
 *   3. a miss is loud (ERROR) and retried — never a silent return.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  remoteSendMock: vi.fn(),
  getRemoteTabStatesMock: vi.fn(),
  refreshRendererCacheMock: vi.fn(),
  logMock: vi.fn(),
  errorMock: vi.fn(),
}))

vi.mock('../../../state', () => ({
  state: { remoteTransport: { send: (...a: any[]) => mocks.remoteSendMock(...a) } },
}))

vi.mock('../../../logger', () => ({
  log: (...a: any[]) => mocks.logMock(...a),
  debug: vi.fn(),
  warn: vi.fn(),
  error: (...a: any[]) => mocks.errorMock(...a),
}))

vi.mock('../../snapshot', () => ({
  getRemoteTabStates: (...a: any[]) => mocks.getRemoteTabStatesMock(...a),
  refreshRendererSnapshotCache: (...a: any[]) => mocks.refreshRendererCacheMock(...a),
}))

vi.mock('../../../settings-store', () => ({ readSettings: vi.fn().mockReturnValue({}) }))
vi.mock('../../../terminal-manager-instance', () => ({ terminalManager: { create: vi.fn() } }))

import { notifyTabCreated } from '../tabs-create-echo'

const TAB = 'tab-created-1'

/** Collapse the retry backoff so failure-path tests assert the ladder without sleeping through it. */
const NO_BACKOFF = [0, 0]

function tabRow(id: string) {
  return {
    id, title: 'New Tab', status: 'idle', workingDirectory: '/w',
    permissionMode: 'auto', permissionQueue: [], lastMessage: null,
    contextTokens: null, contextWindow: null, messageCount: 0,
    queuedPrompts: [], customTitle: null,
  }
}

describe('notifyTabCreated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.refreshRendererCacheMock.mockResolvedValue({ tabs: [], resourceManifest: {} })
  })

  it('emits the echo with no timer advance once the tab is present', async () => {
    mocks.getRemoteTabStatesMock.mockResolvedValue({ tabs: [tabRow(TAB)] })

    // No fake timers, no advance: awaiting the call is sufficient. Under the
    // old 500ms setTimeout this returns before anything is sent.
    const sent = await notifyTabCreated(TAB, 'cc-1')

    expect(sent).toBe(true)
    const echo = mocks.remoteSendMock.mock.calls.map((c) => c[0])
      .find((m) => m?.type === 'desktop_tab_created')
    expect(echo).toBeDefined()
    expect(echo.tab.id).toBe(TAB)
    expect(echo.clientCmdId).toBe('cc-1')
  })

  it('force-refreshes the projection BEFORE reading it', async () => {
    // The regression this pins: reading a "fresh" (< 10s) cache that predates
    // the create returns the pre-create tab list. The refresh must happen, and
    // must happen first.
    const order: string[] = []
    mocks.refreshRendererCacheMock.mockImplementation(async () => {
      order.push('refresh')
      return { tabs: [], resourceManifest: {} }
    })
    mocks.getRemoteTabStatesMock.mockImplementation(async () => {
      order.push('read')
      return { tabs: [tabRow(TAB)] }
    })

    await notifyTabCreated(TAB)

    expect(mocks.refreshRendererCacheMock).toHaveBeenCalled()
    expect(order[0]).toBe('refresh')
    expect(order[1]).toBe('read')
  })

  it('logs an ERROR and retries when the tab is absent, never returning silently', async () => {
    // Absent on the first refresh, present on the second: the retry must
    // recover rather than leaving the client to time out.
    mocks.getRemoteTabStatesMock
      .mockResolvedValueOnce({ tabs: [] })
      .mockResolvedValue({ tabs: [tabRow(TAB)] })

    const sent = await notifyTabCreated(TAB, 'cc-retry', Date.now(), NO_BACKOFF)

    expect(sent).toBe(true)
    expect(mocks.refreshRendererCacheMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    // The miss is observable — the old code's silent return is what made this
    // failure invisible in the logs.
    const missLogged = mocks.errorMock.mock.calls
      .some((c) => String(c[1]).includes('absent from refreshed projection'))
    expect(missLogged).toBe(true)
  })

  it('gives up loudly after the bounded retry ladder', async () => {
    mocks.getRemoteTabStatesMock.mockResolvedValue({ tabs: [] })

    const sent = await notifyTabCreated(TAB, 'cc-gone', Date.now(), NO_BACKOFF)

    expect(sent).toBe(false)
    const gaveUp = mocks.errorMock.mock.calls
      .some((c) => String(c[1]).includes('gave up'))
    expect(gaveUp).toBe(true)
    // No echo may be fabricated for a tab we could not resolve.
    const echoes = mocks.remoteSendMock.mock.calls.map((c) => c[0])
      .filter((m) => m?.type === 'desktop_tab_created')
    expect(echoes).toHaveLength(0)
  })

  it('logs a refresh failure instead of swallowing it', async () => {
    mocks.refreshRendererCacheMock.mockRejectedValue(new Error('renderer gone'))

    const sent = await notifyTabCreated(TAB, undefined, Date.now(), NO_BACKOFF)

    expect(sent).toBe(false)
    const logged = mocks.errorMock.mock.calls
      .some((c) => String(c[1]).includes('projection refresh failed'))
    expect(logged).toBe(true)
  })
})
