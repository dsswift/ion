/**
 * transfer.ts: pins the desktop main-process orchestration seam (spec 15)
 * against a FAKE `Broker` rather than a real server round trip — the
 * server's own transfer semantics (export archive contents, import refusal
 * codes, seal idempotency) are already pinned by
 * `server/src/transfer/__tests__/*.test.ts`. What this file needs to prove is
 * that `exportToFile`/`importFromFile` correctly drive the broker's
 * `sendAction`/`sendBinary`/`onBinary` seam: right args, right ordering,
 * correct byte accumulation, refusal-code passthrough, and temp-file cleanup.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BinaryChannel } from '@ion/shared/studio-wire/channels'
import type { Broker } from '../broker'
import { StudioActionFailure } from '@ion/shared/studio-wire/action-failure'
import { exportToFile, importFromFile, onTransferProgress, cancelTransfer, type TransferProgress } from '../transfer'

type BinaryListener = (environmentId: string, channel: number, key: string, payload: Uint8Array) => void
type PhaseListener = (environmentId: string, phase: { phase: string }) => void

/** A fake Broker exposing only what transfer.ts calls: sendAction, sendBinary, onBinary, onPhase. */
function makeFakeBroker(opts: {
  sendAction: (environmentId: string, action: string, args: unknown[], timeoutMs?: number) => Promise<unknown>
  sendBinary?: (environmentId: string, channel: number, key: string, payload: Uint8Array) => boolean
}) {
  const binaryListeners = new Set<BinaryListener>()
  const phaseListeners = new Set<PhaseListener>()
  const sentChunks: Uint8Array[] = []
  const fake = {
    sendAction: opts.sendAction,
    sendBinary: (environmentId: string, channel: number, key: string, payload: Uint8Array) => {
      sentChunks.push(payload)
      return opts.sendBinary ? opts.sendBinary(environmentId, channel, key, payload) : true
    },
    onBinary: (cb: BinaryListener) => {
      binaryListeners.add(cb)
      return () => binaryListeners.delete(cb)
    },
    onPhase: (cb: PhaseListener) => {
      phaseListeners.add(cb)
      return () => phaseListeners.delete(cb)
    },
  }
  return {
    broker: fake as unknown as Broker,
    emitBinary: (environmentId: string, channel: number, key: string, payload: Uint8Array) => {
      for (const cb of binaryListeners) cb(environmentId, channel, key, payload)
    },
    emitPhase: (environmentId: string, phase: { phase: string }) => {
      for (const cb of phaseListeners) cb(environmentId, phase)
    },
    sentChunks,
  }
}

describe('transfer.exportToFile', () => {
  const cleanupPaths: string[] = []
  afterEach(() => {
    for (const p of cleanupPaths.splice(0)) rmSync(p, { recursive: true, force: true })
  })

  it('receives the streamed archive into a local temp file and reports progress', async () => {
    const payload1 = new Uint8Array([1, 2, 3])
    const payload2 = new Uint8Array([4, 5])
    const { broker, emitBinary } = makeFakeBroker({
      sendAction: async () => ({ transferId: 'transfer-1', totalBytes: 5, rootConversationId: 'root-1' }),
    })

    const progress: TransferProgress[] = []
    const offProgress = onTransferProgress((p) => progress.push(p))

    const resultPromise = exportToFile('env-source', 'tab-1', 'env-target', {}, broker)
    // sendAction's fake resolves on a microtask with no further await inside
    // exportToFile before the onBinary listener is armed, matching the real
    // ordering guarantee (see transfer.ts's module doc).
    await Promise.resolve()
    await Promise.resolve()
    emitBinary('env-source', BinaryChannel.FILE_CHUNK, 'transfer-1', payload1)
    emitBinary('env-source', BinaryChannel.FILE_CHUNK, 'transfer-1', payload2)

    const result = await resultPromise
    offProgress()

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    cleanupPaths.push(result.filePath)
    expect(result.totalBytes).toBe(5)
    expect(result.rootConversationId).toBe('root-1')
    expect(Array.from(readFileSync(result.filePath))).toEqual([1, 2, 3, 4, 5])
    expect(progress.map((p) => p.bytesTransferred)).toEqual([3, 5])
    expect(progress.every((p) => p.tabId === 'tab-1' && p.direction === 'export')).toBe(true)
  })

  // The real failure: ws hands every frame of one read out back to back, so
  // a small archive's chunks and end marker were delivered before the reply's
  // continuation ran, found no listener, and were dropped. The export then
  // waited on bytes that had already come and gone.
  it('keeps chunks and the end marker that arrive before the export reply', async () => {
    let requestedId = ''
    const fake = makeFakeBroker({
      sendAction: async (_env, _action, args) => {
        requestedId = (args[0] as { transferId: string }).transferId
        fake.emitBinary('env-source', BinaryChannel.FILE_CHUNK, requestedId, new Uint8Array([7, 8, 9]))
        fake.emitBinary('env-source', BinaryChannel.FILE_END, requestedId, new Uint8Array(0))
        return { transferId: requestedId, totalBytes: 3, rootConversationId: 'root-1' }
      },
    })
    const result = await exportToFile('env-source', 'tab-early', 'env-target', {}, fake.broker)
    expect(requestedId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    cleanupPaths.push(result.filePath)
    expect([...readFileSync(result.filePath)]).toEqual([7, 8, 9])
  })

  it('ignores binary frames for a different environment or transfer id', async () => {
    const { broker, emitBinary } = makeFakeBroker({
      sendAction: async () => ({ transferId: 'transfer-2', totalBytes: 2, rootConversationId: 'root-2' }),
    })
    const resultPromise = exportToFile('env-source', 'tab-2', 'env-target', {}, broker)
    await Promise.resolve()
    await Promise.resolve()
    emitBinary('env-other', BinaryChannel.FILE_CHUNK, 'transfer-2', new Uint8Array([9, 9]))
    emitBinary('env-source', BinaryChannel.FILE_CHUNK, 'wrong-transfer', new Uint8Array([9, 9]))
    emitBinary('env-source', BinaryChannel.TERMINAL_DATA, 'transfer-2', new Uint8Array([9, 9]))
    emitBinary('env-source', BinaryChannel.FILE_CHUNK, 'transfer-2', new Uint8Array([1, 2]))

    const result = await resultPromise
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    cleanupPaths.push(result.filePath)
    expect(Array.from(readFileSync(result.filePath))).toEqual([1, 2])
  })

  it('surfaces the refusal code from a rejected transfer.export action', async () => {
    const { broker } = makeFakeBroker({
      sendAction: async () => {
        throw new StudioActionFailure('another export is running', 'running')
      },
    })
    const result = await exportToFile('env-source', 'tab-3', 'env-target', {}, broker)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toEqual({ code: 'running', message: 'another export is running' })
  })

  it('fails the receive when the connection goes offline mid-transfer', async () => {
    const { broker, emitBinary, emitPhase } = makeFakeBroker({
      sendAction: async () => ({ transferId: 'transfer-4', totalBytes: 10, rootConversationId: 'root-4' }),
    })
    const resultPromise = exportToFile('env-source', 'tab-4', 'env-target', {}, broker)
    await Promise.resolve()
    await Promise.resolve()
    emitBinary('env-source', BinaryChannel.FILE_CHUNK, 'transfer-4', new Uint8Array([1]))
    emitPhase('env-source', { phase: 'offline' })

    const result = await resultPromise
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.refusal.message).toContain('lost mid-transfer')
  })
})

describe('transfer.importFromFile', () => {
  it('streams the local file and returns the import result, then deletes the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-transfer-import-test-'))
    const filePath = join(dir, 'archive.zip')
    writeFileSync(filePath, Buffer.from([1, 2, 3, 4]))

    let receivedArgs: unknown[] = []
    const { broker, sentChunks } = makeFakeBroker({
      sendAction: async (_env, action, args, timeoutMs) => {
        expect(action).toBe('transfer.import')
        expect(timeoutMs).toBeGreaterThan(30_000)
        receivedArgs = args
        return { rootConversationId: 'root-5', tabId: 'new-tab-5', worktreePath: '/tmp/wt' }
      },
    })

    const progress: TransferProgress[] = []
    const offProgress = onTransferProgress((p) => progress.push(p))
    const result = await importFromFile('env-target', 'tab-5', filePath, null, broker)
    offProgress()

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.rootConversationId).toBe('root-5')
    expect(result.tabId).toBe('new-tab-5')
    expect(result.worktreePath).toBe('/tmp/wt')

    const [{ transferId, totalBytes }] = receivedArgs as [{ transferId: string; totalBytes: number }]
    expect(totalBytes).toBe(4)
    expect(typeof transferId).toBe('string')
    expect(Buffer.concat(sentChunks.map((c) => Buffer.from(c)))).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(progress.every((p) => p.tabId === 'tab-5' && p.direction === 'import')).toBe(true)
    expect(progress.at(-1)?.bytesTransferred).toBe(4)

    expect(existsSync(filePath)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  // The landing is what tells the destination where a conversation leaving
  // without its worktree lives. Dropped on the way, the import refuses it.
  it('carries the chosen landing to transfer.import', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-transfer-import-landing-test-'))
    const filePath = join(dir, 'archive.zip')
    writeFileSync(filePath, Buffer.from([1]))
    let receivedArgs: unknown[] = []
    const { broker } = makeFakeBroker({
      sendAction: async (_env, _action, args) => { receivedArgs = args; return { rootConversationId: 'r', tabId: 't' } },
    })
    await importFromFile('env-target', 'tab-6', filePath, { kind: 'new-worktree', projectDir: '/src/ion', baseBranch: 'main' }, broker)
    expect((receivedArgs as [{ landing?: unknown }])[0].landing).toEqual({ kind: 'new-worktree', projectDir: '/src/ion', baseBranch: 'main' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('deletes the local file even when the import action is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-transfer-import-refusal-test-'))
    const filePath = join(dir, 'archive.zip')
    writeFileSync(filePath, Buffer.from([1, 2]))

    const { broker } = makeFakeBroker({
      sendAction: async () => {
        throw new StudioActionFailure('conversation already exists', 'conversation_exists')
      },
    })

    const result = await importFromFile('env-target', 'tab-6', filePath, null, broker)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toEqual({ code: 'conversation_exists', message: 'conversation already exists' })
    expect(existsSync(filePath)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects and stops streaming when sendBinary reports the connection closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-transfer-import-closed-test-'))
    const filePath = join(dir, 'archive.zip')
    writeFileSync(filePath, Buffer.from([1, 2, 3]))

    const { broker } = makeFakeBroker({
      sendAction: () => new Promise(() => {}), // never resolves; the streaming failure should win
      sendBinary: () => false,
    })

    const result = await importFromFile('env-target', 'tab-7', filePath, null, broker)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.refusal.message).toContain('closed mid-upload')
    expect(existsSync(filePath)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * A stream ends when the sender says so. These pin the three ways a receive
 * can end other than "every declared byte arrived" — each of which used to be
 * an indefinite wait, because the only completion signal was a byte count
 * reaching a total the sender declared up front.
 */
describe('transfer.exportToFile: what the export carries', () => {
  // A worktree conversation moves on its own unless the caller asks for its
  // worktree. Dropping the flag here would turn every whole-worktree move
  // into a conversation-only one, which then lands nowhere.
  it('forwards carryWorktree to transfer.export, and sends false when absent', async () => {
    const sent: unknown[] = []
    const { broker, emitBinary } = makeFakeBroker({
      sendAction: async (_env, _action, args) => { sent.push(args[0]); return { transferId: 't', totalBytes: 1, rootConversationId: 'r' } },
    })
    for (const options of [{ carryWorktree: true }, {}]) {
      const pending = exportToFile('env-source', 'tab-1', 'env-target', options, broker)
      await Promise.resolve(); await Promise.resolve()
      emitBinary('env-source', BinaryChannel.FILE_CHUNK, 't', new Uint8Array([1]))
      const result = await pending
      if (result.ok) rmSync(result.filePath, { force: true })
    }
    expect(sent.map((a) => (a as { carryWorktree: boolean }).carryWorktree)).toEqual([true, false])
  })
})

describe('transfer.exportToFile: ending a stream that is not going to complete', () => {
  const cleanupPaths: string[] = []
  afterEach(() => {
    vi.useRealTimers()
    for (const p of cleanupPaths.splice(0)) rmSync(p, { recursive: true, force: true })
  })

  it('fails when the source ends the stream short of the size it declared', async () => {
    // The shape of the real defect: the export action declared an
    // uncompressed input size while streaming a compressed archive, so the
    // receiver could never reach the total and waited forever.
    const { broker, emitBinary } = makeFakeBroker({
      sendAction: async () => ({ transferId: 'transfer-short', totalBytes: 135662, rootConversationId: 'root-1' }),
    })

    const resultPromise = exportToFile('env-source', 'tab-1', 'env-target', {}, broker)
    await Promise.resolve()
    await Promise.resolve()
    emitBinary('env-source', BinaryChannel.FILE_CHUNK, 'transfer-short', new Uint8Array(53043))
    emitBinary('env-source', BinaryChannel.FILE_END, 'transfer-short', new Uint8Array(0))

    const result = await resultPromise
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal.message).toContain('53043')
    expect(result.refusal.message).toContain('135662')
  })

  it('completes on the end marker when every declared byte did arrive', async () => {
    const { broker, emitBinary } = makeFakeBroker({
      sendAction: async () => ({ transferId: 'transfer-exact', totalBytes: 4, rootConversationId: 'root-1' }),
    })

    const resultPromise = exportToFile('env-source', 'tab-1', 'env-target', {}, broker)
    await Promise.resolve()
    await Promise.resolve()
    emitBinary('env-source', BinaryChannel.FILE_CHUNK, 'transfer-exact', new Uint8Array([1, 2, 3, 4]))
    emitBinary('env-source', BinaryChannel.FILE_END, 'transfer-exact', new Uint8Array(0))

    const result = await resultPromise
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    cleanupPaths.push(result.filePath)
  })

  it('fails a stream that goes quiet without ever ending', async () => {
    vi.useFakeTimers()
    const { broker, emitBinary } = makeFakeBroker({
      sendAction: async () => ({ transferId: 'transfer-stalled', totalBytes: 100, rootConversationId: 'root-1' }),
    })

    const resultPromise = exportToFile('env-source', 'tab-1', 'env-target', {}, broker)
    await vi.advanceTimersByTimeAsync(0)
    emitBinary('env-source', BinaryChannel.FILE_CHUNK, 'transfer-stalled', new Uint8Array(10))

    await vi.advanceTimersByTimeAsync(95_000)

    const result = await resultPromise
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal.message).toContain('10 of 100 bytes')
  })

  it('abandons the receive when the operator cancels', async () => {
    const { broker, emitBinary } = makeFakeBroker({
      sendAction: async () => ({ transferId: 'transfer-cancel', totalBytes: 100, rootConversationId: 'root-1' }),
    })

    const resultPromise = exportToFile('env-source', 'tab-1', 'env-target', {}, broker)
    await Promise.resolve()
    await Promise.resolve()
    emitBinary('env-source', BinaryChannel.FILE_CHUNK, 'transfer-cancel', new Uint8Array(10))

    expect(cancelTransfer('tab-1')).toBe(true)

    const result = await resultPromise
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal.code).toBe('cancelled')
    // Nothing is in flight for that tab any more.
    expect(cancelTransfer('tab-1')).toBe(false)
  })
})

describe('transfer.exportToFile: an archive that never arrives releases its mark', () => {
  // The source marks the conversation as moving when it exports. A download
  // that is cancelled or fails means the destination got nothing, so the
  // mark must come off or the conversation refuses prompts for nothing.
  it('asks the source to release the mark its export set, after a cancel', async () => {
    const calls: Array<{ action: string; args: unknown[] }> = []
    const { broker } = makeFakeBroker({
      sendAction: async (_env, action, args) => {
        calls.push({ action, args })
        if (action === 'transfer.export') return { transferId: (args[0] as { transferId: string }).transferId, totalBytes: 100, rootConversationId: 'root-1', sealedAt: 1234 }
        return { released: true }
      },
    })
    const resultPromise = exportToFile('env-source', 'tab-release', 'env-target', {}, broker)
    await Promise.resolve()
    await Promise.resolve()
    expect(cancelTransfer('tab-release')).toBe(true)
    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(calls.map((c) => c.action)).toEqual(['transfer.export', 'transfer.release'])
    expect(calls[1].args).toEqual([{ tabId: 'tab-release', sealedAt: 1234 }])
  })

  it('does not ask for a release when the export itself was refused', async () => {
    const actions: string[] = []
    const { broker } = makeFakeBroker({
      sendAction: async (_env, action) => {
        actions.push(action)
        throw new StudioActionFailure('tab is running', 'running')
      },
    })
    const result = await exportToFile('env-source', 'tab-refused', 'env-target', {}, broker)
    expect(result.ok).toBe(false)
    expect(actions).toEqual(['transfer.export'])
  })
})

describe('transfer.importFromFile: ending the upload', () => {
  const cleanupPaths: string[] = []
  afterEach(() => {
    for (const p of cleanupPaths.splice(0)) rmSync(p, { recursive: true, force: true })
  })

  it('sends an end marker after the last chunk so the destination never waits on a count', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ion-transfer-test-'))
    cleanupPaths.push(dir)
    const filePath = join(dir, 'archive.zip')
    writeFileSync(filePath, Buffer.from([1, 2, 3, 4]))

    const channels: number[] = []
    const { broker } = makeFakeBroker({
      sendAction: async () => ({ rootConversationId: 'root-1', tabId: 'tab-dest' }),
      sendBinary: (_env, channel) => {
        channels.push(channel)
        return true
      },
    })

    const result = await importFromFile('env-target', 'tab-1', filePath, null, broker)

    expect(result.ok).toBe(true)
    expect(channels).toEqual([BinaryChannel.FILE_CHUNK, BinaryChannel.FILE_END])
  })
})
