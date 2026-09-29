/**
 * An engine_intercept must leave a banner in the tab's conversation. The
 * banner used to depend on a raw engine-event broadcast that nothing
 * received, so an intercept fired and the operator saw nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  recorded: [] as Array<{ key: string; event: { interceptLevel: string; interceptTitle: string; interceptMessage: string } }>,
  sendAbort: vi.fn(),
  activeTabId: 'tab-1' as string | null,
  windowFocused: true,
  interceptEnabled: true,
}))

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../state', () => ({
  state: { remoteTransport: null },
  engineBridge: { sendAbort: h.sendAbort, sendPrompt: vi.fn() },
  deviceFocusMap: new Map(),
}))
vi.mock('../../persistence/settings-store', () => ({
  readSettings: () => ({ interceptEnabled: h.interceptEnabled }),
  SETTINGS_DEFAULTS: { interceptEnabled: true },
}))
vi.mock('../../git/focus-state', () => ({ focusState: { get windowFocused() { return h.windowFocused } } }))
vi.mock('../../store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ activeTabId: h.activeTabId }), setState: vi.fn() },
}))
vi.mock('../../store/slices/engine-event-slice-intercept', () => ({
  handleEngineInterceptEvent: (_set: unknown, key: string, event: { interceptLevel: string; interceptTitle: string; interceptMessage: string }) => {
    h.recorded.push({ key, event })
  },
}))

interface FakeThin { id: string; interceptEnabled: boolean; focused: string | null }
const thin = vi.hoisted(() => ({ conns: [] as FakeThin[], sent: [] as Array<{ to: string; event: Record<string, unknown> }> }))
vi.mock('../../thin-view/remote-out', () => ({
  thinConnections: () => thin.conns,
  sendThinEventTo: (conn: FakeThin, event: Record<string, unknown>) => { thin.sent.push({ to: conn.id, event }); return true },
}))
vi.mock('../../protocol/presence', () => ({ focusedTabOf: (conn: FakeThin) => conn.focused }))

import { handleInterceptEvent } from '../event-wiring-intercept'

beforeEach(() => {
  h.recorded.length = 0
  h.sendAbort.mockReset()
  h.activeTabId = 'tab-1'
  h.interceptEnabled = true
  thin.conns.length = 0
  thin.sent.length = 0
})

describe('handleInterceptEvent', () => {
  it('records a banner-level intercept in the tab conversation', async () => {
    await handleInterceptEvent('tab-1', { type: 'engine_intercept', interceptLevel: 'banner', interceptTitle: 'Heads up', interceptMessage: 'look here' } as never)
    expect(h.recorded).toEqual([{ key: 'tab-1', event: { interceptLevel: 'banner', interceptTitle: 'Heads up', interceptMessage: 'look here' } }])
    expect(h.sendAbort).not.toHaveBeenCalled()
  })

  it('records a redirect as a banner when no device will act on it', async () => {
    // Nobody aborts the run, so a "redirected" banner would be false.
    h.interceptEnabled = false
    await handleInterceptEvent('tab-1', { type: 'engine_intercept', interceptLevel: 'redirect', interceptTitle: 'Stop', interceptMessage: 'do this instead' } as never)
    expect(h.recorded).toHaveLength(1)
    expect(h.recorded[0].event.interceptLevel).toBe('banner')
    expect(h.sendAbort).not.toHaveBeenCalled()
  })

  // A thin client receives the banner as a row on its transcript stream, like
  // every other row; nothing is sent to it on the side.
  it('sends a focused thin client nothing but the recorded row', async () => {
    thin.conns.push({ id: 'conn-here', interceptEnabled: true, focused: 'tab-1' })
    await handleInterceptEvent('tab-1', { type: 'engine_intercept', interceptLevel: 'banner', interceptTitle: 'Heads up', interceptMessage: 'look here' } as never)
    expect(h.recorded).toHaveLength(1)
    expect(thin.sent).toEqual([])
  })

  // A thin client reports focus and its intercept preference through
  // `presence.focus`; it counts exactly as the desktop window does.
  it('a focused thin client that acts on intercepts keeps a redirect a redirect', async () => {
    h.interceptEnabled = false
    h.windowFocused = false
    thin.conns.push({ id: 'conn-here', interceptEnabled: true, focused: 'tab-1' })
    await handleInterceptEvent('tab-1', { type: 'engine_intercept', interceptLevel: 'redirect', interceptTitle: 'Stop', interceptMessage: '' } as never)
    expect(h.recorded[0].event.interceptLevel).toBe('redirect')
    h.windowFocused = true
  })
})
