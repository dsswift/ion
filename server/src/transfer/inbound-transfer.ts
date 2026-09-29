/**
 * transfer/inbound-transfer — accumulates the binary `FILE_CHUNK` frames a
 * client sends after calling `transfer.import{transferId, totalBytes}` into
 * a staging file, then resolves the transfer's handler once every declared
 * byte has arrived (spec 10; `server/src/protocol/terminal-channel.ts`'s
 * FILE_CHUNK case routes here — see that file's module doc for why it was
 * previously a no-op).
 *
 * `transfer.export` streams OUTBOUND over the same channel via
 * `Connection.sendBinary` directly (no accumulation needed on the sending
 * side); this module is import's INBOUND half only.
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'fs'
import { dirname } from 'path'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'transfer.inbound'
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields)
}

interface PendingTransfer {
  connectionId: string
  stream: WriteStream
  totalBytes: number
  receivedBytes: number
  resolve: (path: string) => void
  reject: (err: Error) => void
}

const pending = new Map<string, PendingTransfer>()

/** Visible for tests: how many inbound transfers are currently open. */
export function inboundTransferCount(): number {
  return pending.size
}

/**
 * Register a transfer and return a promise that resolves with `destPath`
 * once `totalBytes` have been written, or rejects if the connection closes
 * first. MUST be called synchronously (no `await` before it) by the
 * `transfer.import` action handler, before that handler yields control —
 * otherwise a client that sends its first chunk immediately after the
 * action frame could race ahead of this registration on the same connection.
 */
export function registerInboundTransfer(
  transferId: string,
  destPath: string,
  totalBytes: number,
  connectionId: string,
): Promise<string> {
  if (pending.has(transferId)) {
    return Promise.reject(new Error(`transfer ${transferId} is already registered`))
  }
  mkdirSync(dirname(destPath), { recursive: true })
  const stream = createWriteStream(destPath)
  return new Promise<string>((resolve, reject) => {
    pending.set(transferId, { connectionId, stream, totalBytes, receivedBytes: 0, resolve, reject })
    stream.on('error', (err) => {
      const entry = pending.get(transferId)
      pending.delete(transferId)
      entry?.reject(err)
    })
    log('registered', { transfer_id: transferId, connection_id: connectionId, total_bytes: totalBytes })
  })
}

/** Called from the binary-frame handler for every `FILE_CHUNK` frame keyed by `transferId`. */
export function writeInboundChunk(transferId: string, payload: Uint8Array): void {
  const entry = pending.get(transferId)
  if (!entry) {
    warn('chunk for unknown or already-completed transfer; dropping', { transfer_id: transferId, byte_length: payload.length })
    return
  }
  entry.receivedBytes += payload.length
  entry.stream.write(Buffer.from(payload))
  if (entry.receivedBytes >= entry.totalBytes) {
    pending.delete(transferId)
    entry.stream.end(() => {
      log('completed', { transfer_id: transferId, received_bytes: entry.receivedBytes })
      entry.resolve(entry.stream.path as string)
    })
  }
}

/**
 * Called for the `FILE_END` frame that follows an upload's last chunk: the
 * client stating that no more bytes are coming. A transfer already completed
 * by its byte count is gone from `pending` and this is a no-op; one that is
 * still open ended short, which is a failure the uploader can see now rather
 * than an upload that hangs until the connection drops.
 */
export function endInboundTransfer(transferId: string): void {
  const entry = pending.get(transferId)
  if (!entry) return
  warn('upload ended short of its declared size', { transfer_id: transferId, received_bytes: entry.receivedBytes, total_bytes: entry.totalBytes })
  abortInboundTransfer(transferId, `upload ended after ${entry.receivedBytes} of ${entry.totalBytes} bytes`)
}

/** Abort a registered transfer (connection closed before it completed). */
export function abortInboundTransfer(transferId: string, reason: string): void {
  const entry = pending.get(transferId)
  if (!entry) return
  pending.delete(transferId)
  entry.stream.destroy()
  entry.reject(new Error(reason))
}

/**
 * Abort every inbound transfer still open on `connectionId`. Called from
 * `listener.ts`'s `ws.on('close', ...)` so a client that disconnects
 * mid-upload does not leave a write stream open and a pending map entry
 * that never resolves.
 */
export function abortInboundTransfersForConnection(connectionId: string, reason: string): void {
  for (const [transferId, entry] of pending) {
    if (entry.connectionId === connectionId) {
      warn('aborting inbound transfer: connection closed', { transfer_id: transferId, connection_id: connectionId })
      abortInboundTransfer(transferId, reason)
    }
  }
}
