import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../logger', () => ({
  log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(),
}))

const { state } = vi.hoisted(() => ({
  state: { remoteTransport: null } as {
    remoteTransport: {
      sendToDevice: (deviceId: string, event: unknown) => void
      send: (event: unknown) => void
    } | null
  },
}))
vi.mock('../../../state', () => ({ state }))

import { handleRequestAgentState } from '../agent-state'
import {
  recordAgentState,
  clearAllAgentState,
} from '../../../agent-state-mirror'
import type { RemoteCommand } from '../../protocol'

const sentToDevice: Array<{ deviceId: string; event: any }> = []

beforeEach(() => {
  sentToDevice.length = 0
  clearAllAgentState()
  state.remoteTransport = {
    sendToDevice: (deviceId, event) => { sentToDevice.push({ deviceId, event: event as any }) },
    send: () => {},
  }
})

function req(tabId: string, instanceId?: string | null): Extract<RemoteCommand, { type: 'desktop_request_agent_state' }> {
  return { type: 'desktop_request_agent_state', tabId, instanceId } as never
}

describe('handleRequestAgentState', () => {
  it('serves the roster from the mirror with no renderer round-trip', () => {
    recordAgentState('tab-1', null, [
      { name: 'a', status: 'running', metadata: { displayName: 'A' } },
    ] as never)

    handleRequestAgentState(req('tab-1', null), 'device-1')

    expect(sentToDevice).toHaveLength(1)
    expect(sentToDevice[0].deviceId).toBe('device-1')
    expect(sentToDevice[0].event.type).toBe('desktop_agent_state')
    expect(sentToDevice[0].event.agents.map((a: { name: string }) => a.name)).toEqual(['a'])
  })

  // An unknown tab must still be answered. Under the complete-snapshot
  // contract an empty roster is the authoritative "no agents are live" signal;
  // silence would leave the client rendering rows the desktop no longer knows
  // about, which is the exact failure the request was sent to resolve.
  it('answers an unknown tab with an empty roster rather than staying silent', () => {
    handleRequestAgentState(req('never-seen', null), 'device-1')

    expect(sentToDevice).toHaveLength(1)
    expect(sentToDevice[0].event.agents).toEqual([])
  })

  it('sends exactly one event per request', () => {
    recordAgentState('tab-1', null, [] as never)
    handleRequestAgentState(req('tab-1', null), 'device-1')
    expect(sentToDevice).toHaveLength(1)
  })

  it('refuses a request with no tabId', () => {
    handleRequestAgentState(req(''), 'device-1')
    expect(sentToDevice).toHaveLength(0)
  })

  it('is a no-op when no transport is attached', () => {
    state.remoteTransport = null
    expect(() => handleRequestAgentState(req('tab-1'), 'device-1')).not.toThrow()
  })

  it('resolves the instance from the mirror when the client omits it', () => {
    recordAgentState('tab-1', 'inst-7', [
      { name: 'scoped', status: 'running', metadata: {} },
    ] as never)

    handleRequestAgentState(req('tab-1'), 'device-1')

    expect(sentToDevice[0].event.instanceId).toBe('inst-7')
    expect(sentToDevice[0].event.agents.map((a: { name: string }) => a.name)).toEqual(['scoped'])
  })
})
