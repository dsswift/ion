/**
 * The socket a server dials: `/v1/agent` on the hub. The first frame must
 * be the server's hello; the registry judges it. After the welcome the
 * server sends reports, the results of the actions the hub asked for, the
 * deploys started on its machine, and the steps of its own installs.
 */
import type { IncomingMessage, Server } from 'http'
import type { Duplex } from 'stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { HUB_AGENT_PATH, type HubAgentFrame, type HubFrame } from '@ion/shared/fleet-hub'
import { watchSocketLiveness } from '@ion/shared/socket-liveness'
import type { AgentSocket, HubRegistry } from './registry'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('hub.agent-socket', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('hub.agent-socket', msg, fields)
}

/** A server that has not said hello by now is dropped. */
const HELLO_TIMEOUT_MS = 10_000
/** A Fleet Report is a few kilobytes per account; this is far above any real one. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024

function parse(raw: unknown): HubAgentFrame | null {
  try {
    const frame = JSON.parse(String(raw)) as { type?: unknown } | null
    if (!frame || typeof frame !== 'object') return null
    if (frame.type === 'hub_hello' || frame.type === 'hub_report' || frame.type === 'hub_action_result' || frame.type === 'hub_deploy' || frame.type === 'hub_install') return frame as HubAgentFrame
    return null
  } catch {
    // silent-ok: the caller logs and drops the unreadable frame
    return null
  }
}

/** Attaches the agent socket to the hub's HTTP server. Returns the close function. */
export function attachAgentSocket(server: Server, registry: HubRegistry): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if ((req.url ?? '').split('?')[0] !== HUB_AGENT_PATH) {
      warn('upgrade refused: not the agent path', { url: req.url })
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws, registry))
  }
  server.on('upgrade', onUpgrade)
  return () => {
    server.off('upgrade', onUpgrade)
    wss.close()
  }
}

function serve(ws: WebSocket, registry: HubRegistry): void {
  let serverId: string | null = null
  const send = (frame: HubFrame): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  }
  const handle: AgentSocket = { send, close: () => ws.close() }
  const helloTimer = setTimeout(() => {
    warn('server said no hello in time; dropping it')
    ws.close()
  }, HELLO_TIMEOUT_MS)
  const stopLiveness = watchSocketLiveness(ws, { onDead: () => warn('server link went quiet; closing it', { environment_id: serverId }) })

  const onFrame = (frame: HubAgentFrame): void => {
    if (serverId === null) {
      if (frame.type !== 'hub_hello') {
        warn('server spoke before its hello; dropping it')
        send({ type: 'hub_refused', reason: 'malformed' })
        ws.close()
        return
      }
      clearTimeout(helloTimer)
      const outcome = registry.hello(frame)
      if (!outcome.ok) {
        send({ type: 'hub_refused', reason: outcome.reason })
        ws.close()
        return
      }
      serverId = outcome.id
      send(outcome.welcome)
      registry.attach(serverId, handle)
      return
    }
    if (frame.type === 'hub_report') registry.report(serverId, frame.report)
    else if (frame.type === 'hub_action_result') registry.actionResult(serverId, frame)
    else if (frame.type === 'hub_deploy') registry.deploy(serverId, frame.deploy)
    else if (frame.type === 'hub_install') registry.install(serverId, frame.progress)
  }

  ws.on('message', (raw) => {
    const frame = parse(raw)
    if (!frame) {
      warn('server sent a frame the hub cannot read', { environment_id: serverId })
      return
    }
    try {
      onFrame(frame)
    } catch (err) {
      // One server's frame must never take the hub down for every other server.
      warn('server frame could not be handled; dropping the server', { environment_id: serverId, frame_type: frame.type, error: String(err) })
      ws.close()
    }
  })
  ws.on('error', (err) => warn('server link error', { environment_id: serverId, error: String(err) }))
  ws.on('close', () => {
    clearTimeout(helloTimer)
    stopLiveness()
    if (serverId !== null) registry.detach(serverId, handle)
    else log('a socket closed before any hello')
  })
}
