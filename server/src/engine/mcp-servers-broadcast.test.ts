import { beforeEach, describe, expect, it, vi } from 'vitest'

const broadcastMock = vi.hoisted(() => vi.fn())
vi.mock('../broadcast', () => ({ broadcast: broadcastMock }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { EVENT_CHANNEL_NAMES } from '@ion/shared/studio-wire/channels'
import { installMcpServersBroadcast, MCP_SERVERS_CHANGED_CHANNEL } from './mcp-servers-broadcast'

function bridge() {
  let cb: ((key: string, event: unknown) => void) | null = null
  return {
    on: (_ev: 'event', fn: (key: string, event: never) => void) => { cb = fn as (key: string, event: unknown) => void },
    emit: (event: unknown) => cb?.('k', event),
  }
}

beforeEach(() => broadcastMock.mockReset())

describe('installMcpServersBroadcast', () => {
  it('republishes the complete snapshot', () => {
    const b = bridge()
    installMcpServersBroadcast(b)
    const mcpServers = [{ name: 'srv', transport: 'http', connected: true, authenticated: true }]
    b.emit({ type: 'engine_mcp_servers', mcpServers })
    expect(broadcastMock).toHaveBeenCalledWith(MCP_SERVERS_CHANGED_CHANNEL, mcpServers)
  })

  it('republishes an empty list when the last server is removed', () => {
    const b = bridge()
    installMcpServersBroadcast(b)
    b.emit({ type: 'engine_mcp_servers' })
    expect(broadcastMock).toHaveBeenCalledWith(MCP_SERVERS_CHANGED_CHANNEL, [])
  })

  it('ignores every other engine event', () => {
    const b = bridge()
    installMcpServersBroadcast(b)
    b.emit({ type: 'engine_working_message', message: 'busy' })
    expect(broadcastMock).not.toHaveBeenCalled()
  })

  it('publishes on a channel the Studio wire actually carries', () => {
    // A channel outside the contract is dropped by publishStudioEvent and no
    // client ever hears it.
    expect(EVENT_CHANNEL_NAMES.has(MCP_SERVERS_CHANGED_CHANNEL)).toBe(true)
  })
})
