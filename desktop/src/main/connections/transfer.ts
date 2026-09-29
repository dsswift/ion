/**
 * transfer — main-process orchestration for spec 15 (Desktop Transfer verb).
 *
 * Turns the broker's raw `sendAction`/`sendBinary`/`onBinary` primitives
 * (spec 07/12) into the two host-facing operations the renderer's transfer
 * flow calls: `exportToFile` (stream a source environment's export archive
 * into a local temp file) and `importFromFile` (stream a local file to a
 * target environment's `transfer.import`, deleting it afterward regardless
 * of outcome). Both report byte-level progress through `onTransferProgress`,
 * keyed by the source tab id, so the renderer's transfer dialog can render a
 * live progress bar without needing a correlation id of its own.
 *
 * A stream ends when the sender says so (a `FILE_END` frame), not when the
 * receiver's byte count reaches a total declared up front. Counting alone
 * cannot tell a slow link from a total that was wrong, and a wrong total
 * therefore waited forever — which is exactly what a compressed archive whose
 * size was reported as its uncompressed input size did. The count is still
 * checked: a `FILE_END` that arrives short fails immediately and says how
 * short. A link that goes quiet without ever ending is caught by the stall
 * timeout, and the operator can abandon either one with `cancelTransfer`.
 *
 * The export archive's chunks can reach this process in the same batch as
 * the export's reply: the WebSocket client delivers every frame of one read
 * back to back, before the reply's promise continuation runs. So this side
 * chooses the transfer id and is listening before it sends the request;
 * nothing depends on the reply arriving first.
 */
import { randomUUID } from 'crypto'
import { createReadStream, createWriteStream, mkdtempSync, statSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { BinaryChannel } from '@ion/shared/studio-wire/channels'
import type { ExportFileResult, ImportFileResult, TransferProgress, TransferRefusal } from '@ion/shared/types-transfer'
import { StudioActionFailure } from '@ion/shared/studio-wire/action-failure'
import type { Broker } from './broker'
import { broker as _broker } from './broker-instance'
import { log as _log, warn as _warn, debug as _debug } from '../logger'

export type { TransferProgress } from '@ion/shared/types-transfer'
import type { ExportFileOptions, TransferLanding } from '@ion/shared/types-transfer'

const TAG = 'transfer'
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug(TAG, msg, fields)
}

const EXPORT_CHUNK_BYTES = 256 * 1024
/**
 * How long a stream may go without a single byte or an end marker before it
 * is declared stalled. Generous on purpose: the sender builds and compresses
 * the archive before its first chunk, and a slow link can pause for a while
 * mid-stream. What this exists to stop is the wait with no end.
 */
const STALL_TIMEOUT_MS = 90_000
/** transfer.import doesn't resolve until every byte streamed in has been processed server-side; 30 minutes comfortably covers a large archive over a slow link. */
const IMPORT_ACTION_TIMEOUT_MS = 30 * 60_000

interface ExportActionValue {
  transferId: string
  totalBytes: number
  rootConversationId: string
  /** When the source marked the tab as moving; what `transfer.release` matches on. Absent from an older source. */
  sealedAt?: number
}

interface ImportActionValue {
  rootConversationId: string
  tabId: string
  worktreePath?: string
}

const progressListeners = new Set<(progress: TransferProgress) => void>()

/**
 * The in-flight stream for each source tab, so the operator can abandon a
 * transfer that is slow, stalled, or simply unwanted. Keyed by source tab id
 * for the same reason progress is: it is the only correlation the renderer
 * holds.
 */
const aborters = new Map<string, (reason: string) => void>()

/**
 * Abandons whatever stream is in flight for `tabId`. The step in progress
 * fails with `cancelled`, which the flow reports as a refusal rather than an
 * error. Returns whether there was anything to cancel.
 *
 * Nothing is sent to the other side: the source has already built its archive
 * and deletes it when its own stream ends, and an import that never completes
 * is aborted server-side when this connection closes or its `FILE_END`
 * arrives short. Cancelling is always safe — it is the receiving half that
 * stops, before any destination state exists.
 */
export function cancelTransfer(tabId: string): boolean {
  const abort = aborters.get(tabId)
  if (!abort) {
    log('cancel requested for a tab with nothing in flight', { tab_id: tabId })
    return false
  }
  log('cancel requested', { tab_id: tabId })
  abort('cancelled by the operator')
  return true
}

/** A refusal the flow renders as a cancellation rather than a failure. */
export class TransferCancelled extends Error {}

/** Subscribes to byte-level progress for every in-flight export/import. Returns an unsubscribe function. */
export function onTransferProgress(cb: (progress: TransferProgress) => void): () => void {
  progressListeners.add(cb)
  return () => progressListeners.delete(cb)
}

function emitProgress(progress: TransferProgress): void {
  for (const cb of progressListeners) cb(progress)
}

function refusalFrom(err: unknown): TransferRefusal {
  if (err instanceof TransferCancelled) return { code: 'cancelled', message: err.message }
  if (err instanceof StudioActionFailure) return { code: err.code ?? 'failed', message: err.message }
  return { code: 'failed', message: err instanceof Error ? err.message : String(err) }
}

/** A fresh temp file path for a received archive, in its own directory. */
function tempFilePath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ion-transfer-'))
  return join(dir, `${prefix}.zip`)
}

/**
 * Requests `transfer.export` on `environmentId` for `tabId`, then receives
 * the streamed archive into a local temp file. Resolves once every declared
 * byte has arrived; the caller (spec 15's `transfer-flow.ts`) owns deleting
 * the file once `importFromFile` has consumed it.
 *
 * The transfer id is chosen here and the receiver is listening before the
 * request is sent, so no chunk can arrive for an id nobody is listening on,
 * however the frames are batched on the way in.
 */
export async function exportToFile(
  environmentId: string,
  tabId: string,
  targetEnvironmentId: string,
  options: ExportFileOptions = {},
  broker: Broker = _broker,
): Promise<ExportFileResult> {
  const transferId = randomUUID()
  const destPath = tempFilePath(`export-${tabId}`)
  const receiver = openArchiveReceiver(broker, environmentId, tabId, transferId, destPath)
  let value: ExportActionValue
  try {
    value = (await broker.sendAction(environmentId, 'transfer.export', [{ tabId, targetEnvironmentId, transferId, includeSourceBranch: options.includeSourceBranch === true, knownTips: options.knownTips ?? [], carryWorktree: options.carryWorktree === true }])) as ExportActionValue
  } catch (err) {
    receiver.abandon('the export was refused')
    const refusal = refusalFrom(err)
    warn('export action refused or failed', { environment_id: environmentId, tab_id: tabId, code: refusal.code, error: refusal.message })
    return { ok: false, refusal }
  }

  if (value.transferId !== transferId) {
    // A source older than client-chosen ids minted its own. Its chunks can
    // still race the reply; the listener follows the id it named.
    warn('source ignored the requested transfer id', { environment_id: environmentId, tab_id: tabId, requested_transfer_id: transferId, transfer_id: value.transferId })
    receiver.rekey(value.transferId)
  }
  log('export accepted; receiving archive', {
    environment_id: environmentId,
    tab_id: tabId,
    transfer_id: value.transferId,
    total_bytes: value.totalBytes,
  })

  try {
    await receiver.expect(value.totalBytes)
  } catch (err) {
    const refusal = refusalFrom(err)
    warn('export archive receive failed', { environment_id: environmentId, tab_id: tabId, transfer_id: value.transferId, error: refusal.message })
    await releaseExportMark(broker, environmentId, tabId, value.sealedAt)
    return { ok: false, refusal }
  }

  return { ok: true, filePath: destPath, totalBytes: value.totalBytes, rootConversationId: value.rootConversationId }
}

/**
 * The archive never arrived here, so it cannot have reached the destination:
 * undo the "moving" mark the source set for this export, or the conversation
 * keeps refusing prompts for a move that is not happening.
 */
async function releaseExportMark(broker: Broker, environmentId: string, tabId: string, sealedAt: number | undefined): Promise<void> {
  if (!sealedAt) {
    warn('source did not say when it marked the tab; the mark stays until the move is finished or abandoned', { environment_id: environmentId, tab_id: tabId })
    return
  }
  try {
    const value = (await broker.sendAction(environmentId, 'transfer.release', [{ tabId, sealedAt }])) as { released?: boolean } | undefined
    log('export mark release answered', { environment_id: environmentId, tab_id: tabId, released: value?.released === true })
  } catch (err) {
    warn('export mark release failed; the mark stays until the move is finished or abandoned', { environment_id: environmentId, tab_id: tabId, error: err instanceof Error ? err.message : String(err) })
  }
}

export interface ArchiveReceiver {
  /** The size the export declared; settles once that many bytes and the end marker are in. */
  expect(totalBytes: number): Promise<void>
  /** Follow a different transfer id, for a source that chose its own. */
  rekey(transferId: string): void
  /** Stop listening; nothing more is expected. */
  abandon(reason: string): void
}

/**
 * Starts writing every chunk for `transferId` to `destPath` at once, before
 * the export's reply says how many bytes to expect. Chunks and the end
 * marker may arrive before that reply; they are kept, not dropped, and the
 * outcome is decided when both the size and the bytes are in.
 */
export function openArchiveReceiver(
  broker: Broker,
  environmentId: string,
  tabId: string,
  transferId: string,
  destPath: string,
): ArchiveReceiver {
  let key = transferId
  let receivedBytes = 0
  let totalBytes: number | null = null
  let ended = false
  let settled = false
  const writeStream = createWriteStream(destPath)
  let resolveDone!: () => void
  let rejectDone!: (err: Error) => void
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  done.catch(() => {}) // silent-ok: a failure before expect() is observed there, where expect() returns this same promise

  let stallTimer: NodeJS.Timeout | undefined
  // Armed only once the size is known: before that the source is still
  // building its archive, which the action's own timeout covers.
  function armStall(): void {
    if (totalBytes === null) return
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      fail(new Error(`no bytes for ${Math.round(STALL_TIMEOUT_MS / 1000)}s after ${receivedBytes} of ${totalBytes} bytes`))
    }, STALL_TIMEOUT_MS)
  }
  function cleanup(): void {
    clearTimeout(stallTimer)
    offBinary()
    offPhase()
    aborters.delete(tabId)
  }
  function fail(err: Error): void {
    if (settled) return
    settled = true
    warn('export archive receive ended without the whole archive', {
      environment_id: environmentId,
      tab_id: tabId,
      transfer_id: key,
      received_bytes: receivedBytes,
      total_bytes: totalBytes ?? -1,
      reason: err.message,
    })
    cleanup()
    writeStream.destroy()
    rejectDone(err)
  }
  function succeed(): void {
    if (settled) return
    settled = true
    log('export archive received', { environment_id: environmentId, tab_id: tabId, transfer_id: key, received_bytes: receivedBytes })
    cleanup()
    writeStream.end(() => resolveDone())
  }
  /** Decides once the size is known: the end marker or a full count finishes it. */
  function settleIfDone(): void {
    if (totalBytes === null) return
    if (receivedBytes >= totalBytes) succeed()
    // The sender says that was all of it. Short means the archive was
    // smaller than the size the export action declared — a real failure,
    // reported now instead of waited out.
    else if (ended) fail(new Error(`the source finished after ${receivedBytes} of the ${totalBytes} bytes it declared`))
  }

  aborters.set(tabId, (reason) => fail(new TransferCancelled(reason)))
  const offPhase = broker.onPhase((envId, phase) => {
    if (envId !== environmentId) return
    if (phase.phase === 'backoff' || phase.phase === 'offline') {
      fail(new Error(`connection to ${environmentId} was lost mid-transfer`))
    }
  })
  const offBinary = broker.onBinary((envId, channel, chunkKey, payload) => {
    if (envId !== environmentId || chunkKey !== key || settled) return
    if (channel === BinaryChannel.FILE_END) {
      ended = true
      if (totalBytes === null) debug('end marker arrived before the export reply', { tab_id: tabId, transfer_id: key, received_bytes: receivedBytes })
      settleIfDone()
      return
    }
    if (channel !== BinaryChannel.FILE_CHUNK) return
    receivedBytes += payload.length
    writeStream.write(Buffer.from(payload))
    if (totalBytes !== null) emitProgress({ tabId, direction: 'export', bytesTransferred: receivedBytes, totalBytes })
    armStall()
    settleIfDone()
  })
  writeStream.on('error', fail)

  return {
    expect(total: number): Promise<void> {
      totalBytes = total
      if (receivedBytes > 0) emitProgress({ tabId, direction: 'export', bytesTransferred: Math.min(receivedBytes, total), totalBytes: total })
      armStall()
      settleIfDone()
      return done
    },
    rekey(next: string): void {
      key = next
    },
    abandon(reason: string): void {
      if (settled) return
      settled = true
      log('export archive receiver abandoned', { environment_id: environmentId, tab_id: tabId, transfer_id: key, reason })
      cleanup()
      writeStream.destroy()
      resolveDone()
    },
  }
}

/**
 * Streams the local file at `filePath` to `environmentId`'s `transfer.import`
 * and deletes it afterward, success or failure. `tabId` is the SOURCE tab
 * being transferred — carried through only to key progress events, since the
 * destination tab does not exist until the import completes.
 */
export async function importFromFile(
  environmentId: string,
  tabId: string,
  filePath: string,
  /** Where a conversation arriving without its worktree lands on the destination, chosen in the dialog from what that machine offers. */
  landing: TransferLanding | null = null,
  broker: Broker = _broker,
): Promise<ImportFileResult> {
  const totalBytes = statSync(filePath).size
  const transferId = randomUUID()

  // Fired synchronously below (before any await), matching the ordering
  // guarantee this module's doc comment describes. `streamFileAsBinary` runs
  // concurrently and may itself throw first (e.g. `sendBinary` reporting the
  // connection closed) without ever awaiting `resultPromise` -- attach a
  // no-op catch immediately so a same-tick rejection here (a refusal that
  // arrives before the upload even starts) isn't reported as an unhandled
  // rejection. The real outcome is still observed below via `await
  // resultPromise`, which reproduces the same rejection if it occurs.
  const resultPromise = broker.sendAction(environmentId, 'transfer.import', [{ transferId, totalBytes, ...(landing ? { landing } : {}) }], IMPORT_ACTION_TIMEOUT_MS)
  resultPromise.catch(() => {}) // silent-ok: only suppresses the same-tick unhandled-rejection warning; the real outcome is observed below via `await resultPromise`, which reproduces this rejection

  try {
    await streamFileAsBinary(broker, environmentId, tabId, transferId, filePath, totalBytes)
    const value = (await resultPromise) as ImportActionValue
    log('import complete', { environment_id: environmentId, tab_id: tabId, transfer_id: transferId, target_tab_id: value.tabId })
    return { ok: true, ...value }
  } catch (err) {
    const refusal = refusalFrom(err)
    warn('import failed', { environment_id: environmentId, tab_id: tabId, transfer_id: transferId, error: refusal.message })
    return { ok: false, refusal }
  } finally {
    try {
      await rm(filePath, { force: true })
    } catch (err) {
      warn('local archive cleanup failed', { file_path: filePath, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

function streamFileAsBinary(
  broker: Broker,
  environmentId: string,
  tabId: string,
  transferId: string,
  filePath: string,
  totalBytes: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let sentBytes = 0
    let settled = false
    const readStream = createReadStream(filePath, { highWaterMark: EXPORT_CHUNK_BYTES })

    function finish(err?: Error): void {
      if (settled) return
      settled = true
      aborters.delete(tabId)
      if (err) {
        readStream.destroy()
        // The destination is waiting on a byte count it will never reach;
        // tell it the upload is over so it fails now rather than holding a
        // staging file open until the connection drops.
        broker.sendBinary(environmentId, BinaryChannel.FILE_END, transferId, new Uint8Array(0))
        reject(err)
        return
      }
      broker.sendBinary(environmentId, BinaryChannel.FILE_END, transferId, new Uint8Array(0))
      log('upload stream complete', { environment_id: environmentId, tab_id: tabId, transfer_id: transferId, sent_bytes: sentBytes })
      resolve()
    }

    aborters.set(tabId, (reason) => finish(new TransferCancelled(reason)))

    readStream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      if (settled) return
      if (!broker.sendBinary(environmentId, BinaryChannel.FILE_CHUNK, transferId, buf)) {
        finish(new Error(`connection to ${environmentId} closed mid-upload`))
        return
      }
      sentBytes += buf.length
      emitProgress({ tabId, direction: 'import', bytesTransferred: sentBytes, totalBytes })
    })
    readStream.on('end', () => finish())
    readStream.on('error', (err: Error) => finish(err))
  })
}
