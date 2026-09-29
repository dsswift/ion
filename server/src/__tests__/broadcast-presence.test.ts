/**
 * FR-02: `broadcast('studio:presence', snapshot)` re-projects onto the client
 * wire as `desktop_presence`, the same pattern `TERMINAL_ACTIVITY`/
 * `TERMINAL_EXIT` already use to reach connected clients.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const deps = vi.hoisted(() => ({
  send: vi.fn(),
  clientsPresent: vi.fn(() => true),
}))

vi.mock('../state', () => ({
  state: {},
  terminalOutputAccumulator: new Map(),
  terminalScrollback: new Map(),
  MAX_SCROLLBACK_SIZE: 1_000_000,
}))
vi.mock('../protocol/events', () => ({ publishStudioEvent: vi.fn() }))
vi.mock('../thin-view/remote-out', () => ({
  sendRemoteEvent: deps.send,
  remoteClientsPresent: deps.clientsPresent,
}))

import { broadcast } from '../broadcast'

beforeEach(() => {
  deps.send.mockClear()
  deps.clientsPresent.mockReturnValue(true)
})

describe('broadcast: studio:presence -> desktop_presence', () => {
  it('re-projects the presence snapshot onto the client wire', () => {
    broadcast('studio:presence', {
      entries: [{ subject: 'oidc:alice', displayName: 'Alice', focusedTabId: 'tab-1' }],
      driving: { 'tab-1': 'oidc:alice' },
    })

    expect(deps.send).toHaveBeenCalledWith({
      type: 'desktop_presence',
      entries: [{ subject: 'oidc:alice', displayName: 'Alice', focusedTabId: 'tab-1' }],
      driving: { 'tab-1': 'oidc:alice' },
    })
  })

  it('does nothing when no client is connected', () => {
    deps.clientsPresent.mockReturnValue(false)
    expect(() => broadcast('studio:presence', { entries: [], driving: {} })).not.toThrow()
    expect(deps.send).not.toHaveBeenCalled()
  })
})
