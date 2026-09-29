/**
 * Writes one Studio wire frame to a connection's socket. An action frame's
 * traceparent goes to a socket that can carry it beside the frame (a relay's
 * outer envelope, for the relay's own span); any other socket gets the frame
 * alone.
 */
import { encodeFrame } from '@ion/shared/studio-wire/codec'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import type { StudioSocketLike } from './sealed-studio-socket'

export function sendFrame(ws: StudioSocketLike, frame: StudioFrame): void {
  const encoded = encodeFrame(frame)
  if (frame.type === 'studio_action' && frame.traceparent && ws.sendTraced) {
    ws.sendTraced(encoded, frame.traceparent)
    return
  }
  ws.send(encoded)
}
