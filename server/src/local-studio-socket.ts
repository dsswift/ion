/**
 * The server side of the local Studio wire address: the shared derivation
 * (`@ion/shared/local-studio-target`) bound to this process's platform and
 * user SID, plus the `ws` dialer the pairing CLI uses.
 */
import { connect as netConnect } from 'net'
import WebSocket from 'ws'
import {
  localPipeName,
  resolveLocalStudioTarget as resolveTarget,
  type LocalStudioTarget,
} from '@ion/shared/local-studio-target'
import { currentUserSid } from './engine/engine-address'

export { localPipeName, type LocalStudioTarget }

/** Where this user's local listener for `dir` lives. Throws on win32 without a SID. */
export function resolveLocalStudioTarget(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  sid: () => string | null = currentUserSid,
): LocalStudioTarget {
  return resolveTarget(dir, platform, sid)
}

/**
 * Opens a `ws` client to a local target. A Unix socket rides the `ws+unix://`
 * URL form; a named pipe cannot be spelled as a URL, so the client is pointed
 * at a placeholder `ws://` URL and `createConnection` substitutes a
 * `net.connect` to the pipe, the documented `ws` pattern for non-TCP
 * transports.
 */
export function dialLocalStudio(target: LocalStudioTarget): WebSocket {
  if (target.kind === 'pipe') {
    return new WebSocket('ws://localhost/studio', { createConnection: () => netConnect(target.path) })
  }
  return new WebSocket(`ws+unix://${target.path}:/studio`)
}
