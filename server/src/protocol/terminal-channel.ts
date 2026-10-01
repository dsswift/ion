/**
 * terminal-channel — bridges the binary Studio wire channel (manifest
 * contract C3: `0x01` terminal data, `0x02` terminal resize, `0x03` file
 * chunk) to its consumers: `terminal-manager.ts` for `0x01`/`0x02`, and
 * `transfer/inbound-transfer.ts` for `0x03` — an inbound `transfer.import`
 * archive upload, keyed by the `transferId` the action call registered
 * (spec 10). `0x03` had no consumer before spec 10; this is that consumer.
 * The `PORT_*` channels go to `port-forward/port-streams.ts`.
 */
import { terminalManager } from '../terminal/terminal-manager-instance'
import { writeInboundChunk, endInboundTransfer } from '../transfer/inbound-transfer'
import { handlePortFrame } from '../port-forward/port-streams'
import { decodeBinary, WireError } from '@ion/shared/studio-wire/codec'
import { BinaryChannel } from '@ion/shared/studio-wire/channels'
import { scopeSatisfies } from '@ion/shared/studio-wire/action-scopes'
import { log as _log, warn as _warn } from '../logger'
import type { Connection } from './connection'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('studio-terminal-channel', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('studio-terminal-channel', msg, fields)
}

/** Parse a 4-byte `[cols BE16][rows BE16]` resize payload. */
function decodeResizePayload(payload: Uint8Array): { cols: number; rows: number } | null {
  if (payload.length < 4) return null
  const cols = (payload[0] << 8) | payload[1]
  const rows = (payload[2] << 8) | payload[3]
  return { cols, rows }
}

/** Handle one inbound binary frame from a Studio connection. */
export function handleBinaryFrame(conn: Connection, data: Uint8Array): void {
  let decoded
  try {
    decoded = decodeBinary(data)
  } catch (err) {
    warn('binary frame failed to decode; dropping', { connection_id: conn.id, error: String(err) })
    return
  }

  const key = decoded.key
  if (decoded.channel === BinaryChannel.FILE_CHUNK) {
    // A file chunk is a transfer.import upload, not a terminal operation —
    // it is scoped like every other transfer action (conversations:operate),
    // not terminal:operate.
    if (!scopeSatisfies(conn.scopes, 'conversations:operate')) {
      warn('file-chunk frame refused: insufficient scope', { connection_id: conn.id, transfer_id: key })
      return
    }
    writeInboundChunk(key, decoded.payload)
    return
  }

  if (decoded.channel === BinaryChannel.FILE_END) {
    // Same scope as the chunks it terminates.
    if (!scopeSatisfies(conn.scopes, 'conversations:operate')) {
      warn('file-end frame refused: insufficient scope', { connection_id: conn.id, transfer_id: key })
      return
    }
    endInboundTransfer(key)
    return
  }

  if (!scopeSatisfies(conn.scopes, 'terminal:operate')) {
    warn('binary frame refused: insufficient scope', { connection_id: conn.id, channel: decoded.channel })
    return
  }

  if (decoded.channel === BinaryChannel.PORT_DATA || decoded.channel === BinaryChannel.PORT_END || decoded.channel === BinaryChannel.PORT_CREDIT) {
    handlePortFrame(conn.id, decoded.channel, key, decoded.payload)
    return
  }

  if (decoded.channel === BinaryChannel.TERMINAL_DATA) {
    const text = Buffer.from(decoded.payload).toString('utf-8')
    terminalManager.write(key, text)
    return
  }
  if (decoded.channel === BinaryChannel.TERMINAL_RESIZE) {
    const size = decodeResizePayload(decoded.payload)
    if (!size) {
      warn('resize frame payload too short', { connection_id: conn.id, key, byte_length: decoded.payload.length })
      return
    }
    terminalManager.resize(key, size.cols, size.rows)
    log('terminal resized via Studio wire', { connection_id: conn.id, key, cols: size.cols, rows: size.rows })
    return
  }
  // decodeBinary already rejects any other byte, so this is unreachable —
  // kept only so a future BinaryChannel addition fails loudly here instead
  // of silently falling through.
  throw new WireError(`unhandled binary channel ${String(decoded.channel)}`)
}
