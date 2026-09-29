/**
 * transport-local — connects to the local server's Studio wire listener
 * (spec 12): a Unix socket everywhere except win32, where it is a named pipe.
 * Where that listener lives is the one shared derivation
 * (`@ion/shared/local-studio-target`) the server binds with, so this side can
 * never dial a name the server did not bind. Renderer `WebSocket` cannot
 * reach either transport (no unix-socket support, no arbitrary named-pipe
 * support), which is why this lives in main and is relayed to the renderer
 * over IPC.
 */
import WebSocket from 'ws'
import { connect as netConnect } from 'net'
import { resolveLocalStudioTarget } from '@ion/shared/local-studio-target'
import { currentUserSid } from '@ion/server/engine/engine-address'
import { warn as _warn } from '../logger'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('connections-transport-local', msg, fields)
}

/**
 * Opens a WebSocket to the local server for the data dir `dir`. Throws when
 * the win32 SID cannot be read (the same condition under which the engine's
 * own per-user address resolution gives up rather than guessing a shared
 * address).
 *
 * A named pipe cannot be spelled as a URL, so on win32 the client is pointed
 * at a placeholder `ws://` URL and `createConnection` substitutes a
 * `net.connect` to the pipe, the documented `ws` pattern for non-TCP
 * transports.
 */
export function connectLocal(dir: string): WebSocket {
  const target = resolveLocalStudioTarget(dir, process.platform, currentUserSid)
  if (target.kind === 'pipe') {
    warn('opening local Studio connection over a named pipe', { path: target.path })
    return new WebSocket('ws://localhost/studio', { createConnection: () => netConnect(target.path) })
  }
  return new WebSocket(`ws+unix://${target.path}:/studio`)
}
