/**
 * log-egress-drain.test.ts — regression tests for the egress spool-drain wedge.
 *
 * Split from log-egress.test.ts (600-line cap). Covers the no-drain root cause
 * and its fixes:
 *   E8  Bounded spool drain: an oversized spool drains in bounded batches
 *       instead of failing forever as one indivisible, undeliverable request.
 *   E9  rewriteSpoolRemainder: the partial-drain progress primitive.
 *   E10 Tailer cursor-past-EOF clamp: a persisted offset beyond EOF resumes at
 *       EOF instead of re-shipping the whole file as duplicates.
 *   E11 Tailer EOF drain: all bytes beyond 64 KiB ship in a single poll pass
 *       (drainFd replaces the single-chunk read in step 5).
 *   E12 Live buffer flushes alongside partial spool drain: live records are
 *       never starved behind a multi-tick spool backlog.
 *
 * E8's oversized-drain case is the RED proof: it fails on the pre-fix
 * whole-spool drain (the single giant POST is rejected and the spool never
 * shrinks) and passes on the bounded drain.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import {
  mkdtempSync,
  writeFileSync,
  appendFileSync,
  openSync,
  fstatSync,
  closeSync,
} from 'fs'
import { tmpdir } from 'os'

// Isolate HOME to a per-file temp dir BEFORE the egress modules are imported,
// so SPOOL_PATH (derived from homedir() at import time) points at a throwaway
// location. Without this the tests read/delete the user's REAL
// ~/.ion/.egress-spool.jsonl and race any other egress test file running in a
// parallel vitest worker. vi.hoisted runs before the import statements below.
vi.hoisted(() => {
  const os = require('os') as typeof import('os')
  const fs = require('fs') as typeof import('fs')
  const p = require('path') as typeof import('path')
  const home = fs.mkdtempSync(p.join(os.tmpdir(), 'ion-egress-home-drain-'))
  fs.mkdirSync(p.join(home, '.ion'), { recursive: true })
  process.env.HOME = home
})

vi.mock('../utils/atomicWrite', () => ({
  atomicWriteFileSync: vi.fn((path: string, content: string) => {
    const fs = require('fs') as typeof import('fs')
    fs.writeFileSync(path, content, 'utf-8')
  }),
}))

import {
  appendToSpool,
  readSpool,
  hasSpoolContent,
  rewriteSpoolRemainder,
  SPOOL_PATH,
  _resetSpoolStateForTest,
  DEFAULT_SPOOL_MAX_BYTES,
} from '../log-egress-spool'
import {
  configureEgress,
  flushEgress,
  closeEgress,
  shipToEgress,
  _resetEgressForTest,
  EgressRecord,
} from '../log-egress'
import {
  _makeStateForTest,
  _pollOnceForTest,
  _closeFdForTest,
  _setShipFnForTest,
  _restoreShipFnForTest,
} from '../log-egress-tailer'

/** Helper: make a minimal valid EgressRecord JSON line. */
function makeEventLine(msg: string): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level: 'INFO',
    msg,
    component: 'engine',
    tag: 'test',
  })
}

// ---------------------------------------------------------------------------
// E8: Bounded spool drain (the no-drain wedge regression)
// ---------------------------------------------------------------------------

describe('Bounded spool drain (E8)', () => {
  /**
   * RED-proof reasoning
   * -------------------
   * The original drain read the ENTIRE spool and shipped it in one POST. When
   * that single request always failed (oversized payload / timeout — modeled
   * here as a sink that rejects any batch larger than the per-batch cap), the
   * drain hit `advanceBackoff(); return` on every tick and never cleared the
   * spool. A 75 MB backlog wedged permanently.
   *
   * The fix ships at most SPOOL_DRAIN_BATCH_RECORDS (500) records per tick and
   * persists the un-shipped remainder. A backlog larger than one batch now
   * makes forward progress: the spool shrinks by one batch per successful tick
   * instead of stalling.
   *
   * On UNFIXED code this test fails: the whole-spool POST of >500 records is
   * rejected by the size-capped sink, the spool is left fully intact, and
   * `hasSpoolContent()` never shrinks.
   */
  beforeEach(async () => {
    // Await a full drain/kill of any prior forwarder BEFORE seeding this test's
    // spool. _resetEgressForTest fires close() un-awaited, so a prior forwarder's
    // late flush would otherwise double-ship against this test's mock.
    await closeEgress()
    _resetEgressForTest()
    _resetSpoolStateForTest()
    try { require('fs').unlinkSync(SPOOL_PATH) } catch {}
  })
  afterEach(async () => { await closeEgress(); _resetEgressForTest() })

  it('drains an oversized spool in bounded batches instead of stalling', async () => {
    // Seed the spool with 1200 records — more than two 500-record batches.
    const seed: string[] = []
    for (let i = 0; i < 1200; i++) {
      seed.push(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'INFO',
        msg: `spooled-${i}`,
        component: 'engine',
        tag: 'test',
      }))
    }
    appendToSpool(seed, DEFAULT_SPOOL_MAX_BYTES)
    expect(readSpool().length).toBe(1200)

    // Sink that accepts a deliverable batch (<=500) but rejects anything larger,
    // modeling the collector's payload cap that the whole-spool POST tripped.
    const shippedCounts: number[] = []
    const mockFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const payload = JSON.parse(init.body) as { resourceLogs: unknown[] }
      const rl = payload.resourceLogs?.[0] as {
        scopeLogs?: Array<{ logRecords?: unknown[] }>
      }
      const count = rl?.scopeLogs?.[0]?.logRecords?.length ?? 0
      shippedCounts.push(count)
      if (count > 500) {
        return { ok: false, status: 413, body: null } as unknown as Response
      }
      return { ok: true, status: 200, body: null } as unknown as Response
    })
    const origFetch = global.fetch
    global.fetch = mockFetch as unknown as typeof fetch

    configureEgress(
      {
        egressTargets: ['otel'],
        egressOtel: { endpoint: 'http://localhost:1' },
        egressFlushIntervalMs: 60_000,
      },
      async () => ({}),
    )

    // Tick 1: drains the first 500, leaves 700 as remainder.
    await flushEgress()
    // Tick 2: drains the next 500, leaves 200.
    await flushEgress()
    // Tick 3: drains the last 200, spool cleared.
    await flushEgress()

    global.fetch = origFetch

    // Every POST was a deliverable (<=500) batch — never the whole-spool blob.
    expect(shippedCounts.every((c) => c <= 500)).toBe(true)
    // The spool fully drained.
    expect(hasSpoolContent()).toBe(false)
    // Three bounded batches: 500 + 500 + 200.
    expect(shippedCounts).toEqual([500, 500, 200])
  })

  it('ships a normal (sub-batch) spool in one tick and clears it', async () => {
    const seed: string[] = []
    for (let i = 0; i < 10; i++) {
      seed.push(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'INFO',
        msg: `normal-${i}`,
        component: 'engine',
        tag: 'test',
      }))
    }
    appendToSpool(seed, DEFAULT_SPOOL_MAX_BYTES)

    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: null })
    const origFetch = global.fetch
    global.fetch = mockFetch as typeof fetch

    configureEgress(
      {
        egressTargets: ['otel'],
        egressOtel: { endpoint: 'http://localhost:1' },
        egressFlushIntervalMs: 60_000,
      },
      async () => ({}),
    )

    await flushEgress()
    global.fetch = origFetch

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(hasSpoolContent()).toBe(false)
  })

  it('skips only a malformed spooled record, ships the rest, and drains', async () => {
    // One malformed line embedded among valid records. The per-record parse
    // guard must drop ONLY the bad line — not abort the whole batch.
    const seed: string[] = [
      JSON.stringify({ ts: new Date().toISOString(), level: 'INFO', msg: 'good-1', component: 'engine' }),
      '{not valid json',
      JSON.stringify({ ts: new Date().toISOString(), level: 'INFO', msg: 'good-2', component: 'engine' }),
    ]
    appendToSpool(seed, DEFAULT_SPOOL_MAX_BYTES)

    let shippedCount = -1
    const mockFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const payload = JSON.parse(init.body) as {
        resourceLogs: Array<{ scopeLogs: Array<{ logRecords: unknown[] }> }>
      }
      shippedCount = payload.resourceLogs[0].scopeLogs[0].logRecords.length
      return { ok: true, status: 200, body: null } as unknown as Response
    })
    const origFetch = global.fetch
    global.fetch = mockFetch as unknown as typeof fetch

    configureEgress(
      {
        egressTargets: ['otel'],
        egressOtel: { endpoint: 'http://localhost:1' },
        egressFlushIntervalMs: 60_000,
      },
      async () => ({}),
    )

    await flushEgress()
    global.fetch = origFetch

    // Two good records shipped; the malformed line was skipped, not fatal.
    expect(shippedCount).toBe(2)
    // Spool cleared — the bad line was dropped with the remainder, not retried
    // forever.
    expect(hasSpoolContent()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// E9: rewriteSpoolRemainder primitive
// ---------------------------------------------------------------------------

describe('rewriteSpoolRemainder (E9)', () => {
  beforeEach(() => {
    _resetSpoolStateForTest()
    try { require('fs').unlinkSync(SPOOL_PATH) } catch {}
  })

  it('overwrites the spool with the remainder', () => {
    appendToSpool(['a', 'b', 'c', 'd'], DEFAULT_SPOOL_MAX_BYTES)
    rewriteSpoolRemainder(['c', 'd'])
    expect(readSpool()).toEqual(['c', 'd'])
  })

  it('deletes the spool when the remainder is empty', () => {
    appendToSpool(['a', 'b'], DEFAULT_SPOOL_MAX_BYTES)
    rewriteSpoolRemainder([])
    expect(hasSpoolContent()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// E10: Tailer cursor-past-EOF clamp on restore (dup-flood regression)
// ---------------------------------------------------------------------------

describe('Cursor past EOF on restore (E10)', () => {
  /**
   * RED-proof reasoning
   * -------------------
   * When a persisted cursor's offset exceeds the current file size (byte-skew,
   * or a shrink while the tailer was down), the restore path used to trust the
   * offset verbatim. The next poll's truncate branch (size < offset) then reset
   * to 0 and re-shipped the ENTIRE file as duplicates — the flood that bloats
   * the egress spool.
   *
   * The fix clamps a past-EOF cursor to the real EOF on restore, so the tailer
   * resumes at end-of-file and ships only NEW lines.
   *
   * On UNFIXED code this test fails: the restore trusts offset=999999, the
   * truncate branch resets to 0, and the pre-existing 'old-line' re-ships as a
   * duplicate — `shipped` contains 'old-line' when it must not.
   */
  let tmpPath: string
  const shipped: EgressRecord[] = []

  beforeEach(() => {
    tmpPath = mkdtempSync(join(tmpdir(), 'ion-e10-'))
    shipped.length = 0
    _setShipFnForTest((rec) => { shipped.push(rec) })
  })
  afterEach(() => { _restoreShipFnForTest() })

  it('clamps a past-EOF cursor to EOF and ships only new lines', async () => {
    const filePath = join(tmpPath, 'telemetry.jsonl')
    const oldLine = makeEventLine('old-line')
    writeFileSync(filePath, oldLine + '\n', 'utf-8')

    // Compute the real fileId so the cursor matches (the fileId gate must pass
    // for the restore branch to run).
    const fd = openSync(filePath, 'r')
    const info = fstatSync(fd)
    const ino = info.ino
    const fileId = (typeof ino === 'bigint' ? ino !== 0n : ino !== 0)
      ? String(ino)
      : `size:${info.size}`
    closeSync(fd)

    // Seed a cursor whose offset is FAR past the current EOF.
    const cursors: Record<string, { offset: number; fileId: string }> = {
      [filePath]: { offset: 999_999, fileId },
    }

    const state = _makeStateForTest(filePath)
    // Poll 1: opens the file, restores cursor. The clamp must fire → offset=EOF.
    await _pollOnceForTest(state, cursors)
    expect(state.offset).toBe(info.size)

    // Append a genuinely new line and poll again.
    const newLine = makeEventLine('new-line')
    appendFileSync(filePath, newLine + '\n', 'utf-8')
    await _pollOnceForTest(state, cursors)

    const msgs = shipped.map((r) => r.msg)
    // Only the new line ships — the old line must NOT re-ship as a duplicate.
    expect(msgs).toContain('new-line')
    expect(msgs).not.toContain('old-line')

    _closeFdForTest(state)
  })
})

// ---------------------------------------------------------------------------
// E11: Tailer drains all bytes to EOF in a single poll pass
// ---------------------------------------------------------------------------

describe('EOF drain in single poll pass (E11)', () => {
  /**
   * RED-proof reasoning
   * -------------------
   * The old step 5 read a single 64 KiB chunk per poll tick. A file with more
   * than 64 KiB of new data required multiple poll ticks (and poll intervals)
   * to fully catch up — 1 MB took 16 polls × 2 s = 32 s of lag.
   *
   * The fix replaces the single-chunk read with drainFd(), which loops in
   * READ_CHUNK_BYTES increments until state.offset == fdInfo.size. A single
   * _pollOnceForTest call now ships ALL lines regardless of total size.
   *
   * On UNFIXED code this test fails: only the first 64 KiB worth of lines
   * ship in one poll, so shipped.length < totalLines and the assertion fails.
   */
  let tmpPath: string
  const shipped: EgressRecord[] = []

  beforeEach(() => {
    tmpPath = mkdtempSync(join(tmpdir(), 'ion-e11-'))
    shipped.length = 0
    _setShipFnForTest((rec) => { shipped.push(rec) })
  })
  afterEach(() => { _restoreShipFnForTest() })

  it('ships all lines beyond 64 KiB in a single poll pass', async () => {
    const filePath = join(tmpPath, 'engine.jsonl')

    // Build enough lines to exceed two 64-KiB chunks. Each line is ~120 bytes;
    // 1200 lines ≈ 144 KiB, comfortably beyond a single READ_CHUNK_BYTES pass.
    const totalLines = 1200
    const lines: string[] = []
    for (let i = 0; i < totalLines; i++) {
      lines.push(makeEventLine(`burst-line-${i}`))
    }
    writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')

    const cursors: Record<string, { offset: number; fileId: string }> = {}
    const state = _makeStateForTest(filePath)

    // Poll 1: opens the file, seeks to EOF (no saved cursor). No lines shipped yet.
    await _pollOnceForTest(state, cursors)
    // Rewind so the next poll reads from the beginning.
    state.offset = 0

    // Poll 2: should drain ALL lines to EOF in a single pass.
    await _pollOnceForTest(state, cursors)

    // Every line must have shipped in this one poll — not just the first chunk.
    expect(shipped.length).toBe(totalLines)
    const msgs = shipped.map((r) => r.msg)
    expect(msgs).toContain('burst-line-0')
    expect(msgs).toContain(`burst-line-${totalLines - 1}`)

    _closeFdForTest(state)
  })
})

// ---------------------------------------------------------------------------
// E12: Live buffer flushes in the same tick as a partial spool drain
// ---------------------------------------------------------------------------

describe('Live buffer flushes alongside partial spool drain (E12)', () => {
  /**
   * RED-proof reasoning
   * -------------------
   * The original flush() returned early (`if (remainderLines.length > 0) return`)
   * after shipping a spool batch that still had a remainder. During multi-tick
   * drain, every tick went to spool-only; the live buffer never flushed until the
   * spool was empty. A 1500-record spool blocked live data for 3 × 5 s = 15 s.
   *
   * The fix removes the early return. Each tick now ships one bounded spool
   * batch AND drains the live buffer (two POSTs per tick, both bounded). Live
   * records are never starved regardless of spool depth.
   *
   * On UNFIXED code this test fails: the live record POST never fires on tick 1
   * because flush() returns after the 500-record spool batch with 100 remaining.
   */
  beforeEach(async () => {
    await closeEgress()
    _resetEgressForTest()
    _resetSpoolStateForTest()
    try { require('fs').unlinkSync(SPOOL_PATH) } catch {}
  })
  afterEach(async () => { await closeEgress(); _resetEgressForTest() })

  it('ships live records in the same tick as a partial spool drain', async () => {
    // Seed spool with 600 records — more than one 500-record batch, so after
    // tick 1 there is a 100-record remainder still on disk.
    const spoolSeed: string[] = []
    for (let i = 0; i < 600; i++) {
      spoolSeed.push(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'INFO',
        msg: `spool-line-${i}`,
        component: 'engine',
        tag: 'test',
      }))
    }
    appendToSpool(spoolSeed, DEFAULT_SPOOL_MAX_BYTES)
    expect(readSpool().length).toBe(600)

    // Track every POST body (spool drain + live buffer are separate calls).
    const postBodies: string[][] = []
    const mockFetch = vi.fn(async (_url: string, init: { body: string }) => {
      const payload = JSON.parse(init.body) as { resourceLogs: unknown[] }
      const rl = payload.resourceLogs?.[0] as {
        scopeLogs?: Array<{ logRecords?: Array<{ body?: { stringValue?: string } }> }>
      }
      const records = rl?.scopeLogs?.[0]?.logRecords ?? []
      postBodies.push(records.map((r) => r.body?.stringValue ?? ''))
      return { ok: true, status: 200, body: null } as unknown as Response
    })
    const origFetch = global.fetch
    global.fetch = mockFetch as unknown as typeof fetch

    configureEgress(
      {
        egressTargets: ['otel'],
        egressOtel: { endpoint: 'http://localhost:1' },
        egressFlushIntervalMs: 60_000,
      },
      async () => ({}),
    )

    // Ship a live record directly into the buffer.
    shipToEgress({
      ts: new Date().toISOString(),
      level: 'INFO',
      msg: 'live-record-marker',
      component: 'desktop',
      tag: 'test',
    })

    // Single flush tick: must ship spool batch (500) AND the live record.
    await flushEgress()
    global.fetch = origFetch

    // Two POSTs must have fired: one for the spool batch, one for the live buffer.
    expect(postBodies.length).toBe(2)

    // One of the POST bodies must contain the live marker.
    const allBodies = postBodies.flat()
    expect(allBodies.some((b) => b === 'live-record-marker')).toBe(true)

    // The spool still has 100 records (drained 500 of 600 on this tick).
    expect(hasSpoolContent()).toBe(true)
    expect(readSpool().length).toBe(100)
  })
})
