/**
 * Republishes the engine's `engine_mcp_servers` snapshot to every Studio
 * connection.
 *
 * The engine emits the snapshot on every add, remove, login, and logout,
 * whichever client caused it -- including an `ion mcp login` run in a
 * terminal. A settings surface that is already open has no other way to
 * learn about a change it did not make.
 *
 * The payload is the complete server list: a receiver REPLACES its state.
 */

import type { EngineEvent, McpServerStatus } from '@ion/shared/types-engine-event'
import { log } from '../logger'
import { broadcast } from '../broadcast'

export const MCP_SERVERS_CHANGED_CHANNEL = 'ion:mcp-servers-changed'

export function installMcpServersBroadcast(
  engineBridge: { on: (ev: 'event', cb: (key: string, event: EngineEvent) => void) => void },
): void {
  engineBridge.on('event', (key: string, event: EngineEvent) => {
    if (event.type !== 'engine_mcp_servers') return
    const servers: McpServerStatus[] = event.mcpServers ?? []
    log('mcp_servers', 'mcp servers snapshot republished', {
      key,
      count: servers.length,
      connected: servers.filter((s) => s.connected).length,
      authenticated: servers.filter((s) => s.authenticated).length,
    })
    broadcast(MCP_SERVERS_CHANGED_CHANNEL, servers)
  })
}
