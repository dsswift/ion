/**
 * log-egress-bounds.test.ts — regressions for the egress spool/buffer bombs.
 *
 * Two caps, two jobs: the spool cap bounds DISK, MAX_BUFFER_RECORDS bounds
 * HEAP. Both existed only on paper before this file:
 *
 *   B1 trimSpoolToCap was O(n²) — `lines.shift()` (itself O(n)) followed by a
 *      full `lines.join('\n')` and a `Buffer.byteLength` over the result, once
 *      per dropped line. The cap could not be enforced precisely when the
 *      spool was badly over it, so an oversized spool stayed oversized while
 *      the trim burned CPU. The engine's identical loop took a 1.37 GB spool
 *      (grown while an OTLP sink returned 401) and pinned a core with a 9.5 GB
 *      heap for the life of the process — the engine never reached its socket
 *      bind and every conversation on the machine went dark.
 *
 *   B2 The live buffer had no cap at all. Every path that skips it — an active
 *      backoff window, a failed spool-drain batch — returns while ship() keeps
 *      appending, so a permanently-failing sink grew the array without limit.
 *
 * B1's timing case is the RED proof: the old trim cannot finish the fixture
 * inside the deadline, the single-pass trim finishes in milliseconds.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, writeFileSync, statSync, readFileSync, unlinkSync } from 'fs'

// Isolate HOME before the egress modules are imported so SPOOL_PATH (derived
// from homedir() at import time) points at a throwaway location rather than
// the operator's real ~/.ion/.egress-spool.jsonl.
vi.hoisted(() => {
  const os = require('os') as typeof import('os')
  const fs = require('fs') as typeof import('fs')
  const p = require('path') as typeof import('path')
  const home = fs.mkdtempSync(p.join(os.tmpdir(), 'ion-egress-home-bounds-'))
  fs.mkdirSync(p.join(home, '.ion'), { recursive: true })
  process.env.HOME = home
})

vi.mock('../utils/atomicWrite', () => ({
  atomicWriteFileSync: vi.fn((path: string, content: string) => {
    const fs = require('fs') as typeof import('fs')
    fs.writeFileSync(path, content, 'utf-8')
  }),
}))

import { trimSpoolToCap, SPOOL_PATH, _resetSpoolStateForTest } from '../log-egress-spool'
import {
  configureEgress,
  closeEgress,
  shipToEgress,
  _resetEgressForTest,
  _getBufferLengthForTest,
  EgressRecord,
} from '../log-egress'

/** Build an NDJSON spool file of `count` records; returns its byte size. */
function seedSpool(count: number, prefix: string): number {
  const lines: string[] = []
  for (let i = 0; i < count; i++) {
    lines.push(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'INFO',
        msg: `${prefix}-${String(i).padStart(8, '0')}`,
        component: 'desktop',
        tag: 'test',
      }),
    )
  }
  writeFileSync(SPOOL_PATH, lines.join('\n') + '\n', 'utf-8')
  return statSync(SPOOL_PATH).size
}

function spoolLines(): string[] {
  if (!existsSync(SPOOL_PATH)) return []
  const content = readFileSync(SPOOL_PATH, 'utf-8').replace(/\n$/, '')
  return content.length === 0 ? [] : content.split('\n')
}

beforeEach(() => {
  _resetSpoolStateForTest()
  if (existsSync(SPOOL_PATH)) unlinkSync(SPOOL_PATH)
})

afterEach(() => {
  if (existsSync(SPOOL_PATH)) unlinkSync(SPOOL_PATH)
})

// ---------------------------------------------------------------------------
// B1: trimming a badly-oversized spool must be linear
// ---------------------------------------------------------------------------

describe('Spool cap trim (B1)', () => {
  it('trims a spool ~80x over cap in a single pass, keeping the newest records', () => {
    // ~80k records against a 100 KB cap. The single-pass trim finishes in
    // milliseconds; the old shift+join loop needs ~79k passes over ~8 MB.
    const CAP = 100 * 1024
    const size = seedSpool(80_000, 'trim')
    expect(size).toBeGreaterThan(CAP)

    const started = Date.now()
    trimSpoolToCap(CAP)
    const elapsed = Date.now() - started

    // Generous by two orders of magnitude for the fixed implementation, and a
    // small fraction of what the O(n²) loop needs — never a coin-flip.
    expect(elapsed).toBeLessThan(5_000)
    expect(statSync(SPOOL_PATH).size).toBeLessThanOrEqual(CAP)

    const lines = spoolLines()
    expect(lines.length).toBeGreaterThan(0)

    // Every survivor parses: the realignment must not leave a half-record at
    // the front of the file.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }

    // Drop-oldest FIFO: the newest record survives, the oldest does not.
    const newest = JSON.parse(lines[lines.length - 1]) as EgressRecord
    const oldest = JSON.parse(lines[0]) as EgressRecord
    expect(newest.msg).toBe('trim-00079999')
    expect(oldest.msg).not.toBe('trim-00000000')
  })

  it('realigns to a record boundary when the cap lands mid-record', () => {
    const size = seedSpool(200, 'align')
    // A cap deliberately unaligned to any record boundary.
    const cap = Math.floor(size / 2) + 37

    trimSpoolToCap(cap)

    for (const line of spoolLines()) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    expect(statSync(SPOOL_PATH).size).toBeLessThanOrEqual(cap)
  })

  it('leaves a spool under cap byte-for-byte untouched', () => {
    seedSpool(10, 'noop')
    const before = readFileSync(SPOOL_PATH, 'utf-8')

    trimSpoolToCap(1024 * 1024)

    expect(readFileSync(SPOOL_PATH, 'utf-8')).toBe(before)
  })

  it('removes the spool when the cap is smaller than the newest record', () => {
    seedSpool(50, 'tiny')
    trimSpoolToCap(1)
    expect(existsSync(SPOOL_PATH)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// B2: the live buffer must be bounded
// ---------------------------------------------------------------------------

describe('Live buffer cap (B2)', () => {
  afterEach(async () => {
    await closeEgress()
    _resetEgressForTest()
  })

  it('evicts oldest records instead of growing without bound while the sink is down', async () => {
    // A sink that always rejects: the forwarder enters backoff and every
    // subsequent flush returns before touching the live buffer. On the
    // unfixed code ship() then grows the array forever.
    const fetchMock = vi.fn(() => Promise.resolve(new Response('nope', { status: 503 })))
    vi.stubGlobal('fetch', fetchMock)

    configureEgress({
      egressTargets: ['http'],
      egressEndpoint: 'http://127.0.0.1:1/ingest',
      egressFlushIntervalMs: 3_600_000, // ticker never fires; we drive flushes
    })

    const OVERSHOOT = 60_000 // > MAX_BUFFER_RECORDS (50k)
    for (let i = 0; i < OVERSHOOT; i++) {
      shipToEgress({
        ts: new Date().toISOString(),
        level: 'INFO',
        msg: `rec-${i}`,
        component: 'desktop',
        tag: 'test',
      })
    }

    const buffered = _getBufferLengthForTest()
    expect(buffered).toBe(50_000)
    expect(buffered).toBeLessThan(OVERSHOOT)

    vi.unstubAllGlobals()
  })
})
