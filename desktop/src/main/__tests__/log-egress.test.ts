/**
 * log-egress.test.ts — tests for the log-egress forwarder.
 *
 * Coverage:
 *   E1  Rename-drain: orphaned tail bytes ship before the new file is tailed.
 *   E1b Truncate-in-place: same inode, size < offset → reset to 0, re-ship from start.
 *   E2  Persistent cursor: restart resumes at the last shipped offset.
 *   E3  Spool on failure: failed flush appends to the spool.
 *   E4  Spool drain FIFO: next flush drains spool before live buffer.
 *   E5  Spool cap: oversized spool trims oldest records.
 *   E6  Ship queues records and flush drains buffer.
 *   E7  Close drains remaining buffer.
 *
 * Note: E1 is the rename-drain RED proof. It fails on the old tailer (stat-only
 * design) because the orphaned tail bytes are never shipped.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import {
  writeFileSync,
  mkdtempSync,
  appendFileSync,
  renameSync,
  truncateSync,
} from 'fs'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// Module mock setup — must come before imports that pull from the modules
// ---------------------------------------------------------------------------

// Isolate HOME to a per-file temp dir BEFORE the egress modules are imported,
// so SPOOL_PATH (derived from homedir() at import time) points at a throwaway
// location. Without this the tests read/delete the user's REAL
// ~/.ion/.egress-spool.jsonl and race any other egress test file running in a
// parallel vitest worker. vi.hoisted runs before the import statements below.
vi.hoisted(() => {
  const os = require('os') as typeof import('os')
  const fs = require('fs') as typeof import('fs')
  const p = require('path') as typeof import('path')
  const home = fs.mkdtempSync(p.join(os.tmpdir(), 'ion-egress-home-main-'))
  fs.mkdirSync(p.join(home, '.ion'), { recursive: true })
  process.env.HOME = home
})

// We need to control the file system calls in the tailer. We'll test the
// spool and cursor modules directly with real file I/O in temp dirs.

vi.mock('../utils/atomicWrite', () => ({
  atomicWriteFileSync: vi.fn((path: string, content: string) => {
    const fs = require('fs') as typeof import('fs')
    fs.writeFileSync(path, content, 'utf-8')
  }),
}))

// Import after mocks are registered.
import {
  appendToSpool,
  readSpool,
  clearSpool,
  hasSpoolContent,
  SPOOL_PATH,
  _resetSpoolStateForTest,
} from '../log-egress-spool'
import {
  loadCursors,
  saveCursors,
  fileIdForPath,
} from '../log-egress-cursors'
import {
  configureEgress,
  shipToEgress,
  flushEgress,
  closeEgress,
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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ion-egress-test-'))
}

function _makeSinkServer(options: { fail?: boolean } = {}) {
  let received: EgressRecord[] = []
  let shouldFail = options.fail ?? false
  const calls: number[] = []

  const handler = async (records: EgressRecord[]) => {
    calls.push(Date.now())
    if (shouldFail) {
      throw new Error('sink unavailable (503)')
    }
    received.push(...records)
    return { ok: true }
  }

  return {
    received,
    calls,
    setFail: (f: boolean) => { shouldFail = f },
    handler,
  }
}

// ---------------------------------------------------------------------------
// Spool unit tests (direct file I/O, no networking)
// ---------------------------------------------------------------------------

describe('EgressSpool', () => {
  const dir = tempDir()
  const _spoolPath = join(dir, '.egress-spool.jsonl')

  // Override the module's SPOOL_PATH by writing directly.
  // Note: these tests write to tempDir but check the module constant for
  // correctness. We test appendToSpool/readSpool/trimSpoolToCap directly.

  beforeEach(() => {
    _resetSpoolStateForTest()
    // Clean up spool file between tests.
    try {
      require('fs').unlinkSync(SPOOL_PATH)
    } catch {}
  })

  it('E3: appends records on failed flush', () => {
    appendToSpool(['{"msg":"a"}', '{"msg":"b"}'])
    expect(hasSpoolContent()).toBe(true)
    const lines = readSpool()
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]).msg).toBe('a')
    expect(JSON.parse(lines[1]).msg).toBe('b')
  })

  it('E4: reads lines in FIFO order', () => {
    appendToSpool(['{"msg":"first"}'])
    appendToSpool(['{"msg":"second"}'])
    const lines = readSpool()
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]).msg).toBe('first')
    expect(JSON.parse(lines[1]).msg).toBe('second')
  })

  it('E5: trims oldest records when cap exceeded', () => {
    // Each record is ~15 bytes; cap at 50 bytes → ~3 records fit.
    const smallCap = 50
    for (let i = 0; i < 10; i++) {
      appendToSpool([`{"msg":"record-${i}"}`], smallCap)
    }
    const lines = readSpool()
    // Some records should have been trimmed.
    expect(lines.length).toBeLessThan(10)
    // All remaining lines must be valid JSON.
    for (const l of lines) {
      expect(() => JSON.parse(l)).not.toThrow()
    }
  })

  it('clearSpool removes the spool file', () => {
    appendToSpool(['{"msg":"x"}'])
    expect(hasSpoolContent()).toBe(true)
    clearSpool()
    expect(hasSpoolContent()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Cursor unit tests (direct file I/O in temp dir)
// ---------------------------------------------------------------------------

describe('EgressCursors', () => {
  it('E2: saveCursors / loadCursors round-trip', () => {
    const cursors = {
      '/a/b.jsonl': { offset: 1234, fileId: 'ino-5678' },
    }
    saveCursors(cursors)
    const loaded = loadCursors()
    expect(loaded['/a/b.jsonl']).toBeDefined()
    expect(loaded['/a/b.jsonl'].offset).toBe(1234)
    expect(loaded['/a/b.jsonl'].fileId).toBe('ino-5678')
  })

  it('loadCursors returns empty map when file absent', () => {
    const loaded = loadCursors()
    // Should not throw and should return an object.
    expect(typeof loaded).toBe('object')
  })

  it('fileIdForPath returns non-empty string for existing file', () => {
    const d = tempDir()
    const p = join(d, 'test.txt')
    writeFileSync(p, 'content')
    const id = fileIdForPath(p)
    expect(id.length).toBeGreaterThan(0)
  })

  it('fileIdForPath returns empty string for missing file', () => {
    const id = fileIdForPath('/nonexistent/path/file.txt')
    expect(id).toBe('')
  })
})

// ---------------------------------------------------------------------------
// EgressForwarder integration tests (intercept HTTP calls)
// ---------------------------------------------------------------------------

describe('EgressForwarder', () => {
  beforeEach(() => {
    _resetEgressForTest()
    _resetSpoolStateForTest()
    try {
      require('fs').unlinkSync(SPOOL_PATH)
    } catch {}
  })

  afterEach(() => {
    _resetEgressForTest()
  })

  it('E6: ship queues records, flush drains buffer', async () => {
    const _received: EgressRecord[] = []
    configureEgress(
      {
        egressTargets: ['http'],
        egressEndpoint: 'http://localhost:1', // unreachable — we mock fetch below
        egressFlushIntervalMs: 60_000,
      },
      async () => ({}),
    )

    // Mock fetch to capture what would be sent.
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: null })
    const origFetch = global.fetch
    global.fetch = mockFetch as typeof fetch

    const rec: EgressRecord = {
      ts: new Date().toISOString(),
      level: 'INFO',
      msg: 'test-message',
      component: 'engine',
      tag: 'test',
    }
    shipToEgress(rec)
    await flushEgress()

    global.fetch = origFetch

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const call = mockFetch.mock.calls[0]
    const body = JSON.parse(call[1].body as string) as EgressRecord[]
    expect(body.some((r) => r.msg === 'test-message')).toBe(true)
  })

  it('E7: close drains remaining buffer', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: null })
    const origFetch = global.fetch
    global.fetch = mockFetch as typeof fetch

    configureEgress(
      {
        egressTargets: ['http'],
        egressEndpoint: 'http://localhost:1',
        egressFlushIntervalMs: 60_000,
      },
      async () => ({}),
    )

    shipToEgress({
      ts: new Date().toISOString(),
      level: 'INFO',
      msg: 'close-drain-test',
      component: 'engine',
      tag: 'test',
    })

    await closeEgress()
    global.fetch = origFetch

    // close() must have triggered a flush.
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  // F (#310): every record shipped through the funnel is stamped with a
  // unique event_id; a record that already carries one keeps it.
  it('stamps a unique event_id on every shipped record', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, body: null })
    const origFetch = global.fetch
    global.fetch = mockFetch as typeof fetch

    configureEgress(
      {
        egressTargets: ['http'],
        egressEndpoint: 'http://localhost:1',
        egressFlushIntervalMs: 60_000,
      },
      async () => ({}),
    )

    for (let i = 0; i < 3; i++) {
      shipToEgress({ ts: new Date().toISOString(), level: 'INFO', msg: `m${i}`, component: 'engine', tag: 'test' })
    }
    // A record already carrying an event_id keeps it.
    shipToEgress({ ts: new Date().toISOString(), level: 'INFO', msg: 'preset', component: 'engine', tag: 'test', event_id: 'preexisting012345' })

    await flushEgress()
    global.fetch = origFetch

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string) as EgressRecord[]
    const ids = new Set<string>()
    for (const r of body) {
      expect(typeof r.event_id).toBe('string')
      expect(r.event_id).toBeTruthy()
      ids.add(r.event_id as string)
    }
    expect(ids.size).toBe(body.length) // all unique
    expect(body.find((r) => r.msg === 'preset')?.event_id).toBe('preexisting012345')
  })
})

// ---------------------------------------------------------------------------
// E1 + E1b: Tailer integration tests (real fs, real fds, injectable ship fn)
// ---------------------------------------------------------------------------

/**
 * Helper: make a minimal valid EgressRecord JSON line.
 */
function makeEventLine(msg: string): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level: 'INFO',
    msg,
    component: 'engine',
    tag: 'test',
  })
}

describe('Rename-drain (E1)', () => {
  /**
   * RED-proof reasoning
   * -------------------
   * The rename-drain path lives in pollFile step 3: when stat(path).ino ≠
   * fstat(fd).ino, drainFd() is called before the old fd is closed. That
   * call ships bytes between state.offset and fdInfo.size — the "orphaned
   * tail" written to the file after it was renamed but before the new file
   * appeared at the original path.
   *
   * If drainFd is disabled (or the inode comparison is broken), the orphaned
   * bytes are silently lost: the old fd is closed, state is reset to 0, and
   * the next poll opens the new file at offset 0. Event B (orphaned-tail)
   * would never arrive in `shipped`. The assertion `expect(msgs).toContain('orphaned-tail')`
   * would fail.
   *
   * The test also asserts ordering (B before C) and cursor advancement so
   * that the cursor-write path inside drainFd is exercised.
   */
  let tmpPath: string
  const shipped: EgressRecord[] = []

  beforeEach(() => {
    tmpPath = mkdtempSync(join(tmpdir(), 'ion-e1-'))
    shipped.length = 0
    _setShipFnForTest((rec) => { shipped.push(rec) })
  })

  afterEach(() => {
    _restoreShipFnForTest()
  })

  it('ships event A, then orphaned B and new-file C in order after rename rotation', async () => {
    const filePath = join(tmpPath, 'engine.jsonl')
    const rotatedPath = join(tmpPath, 'engine.jsonl.bak')
    const cursors: Record<string, { offset: number; fileId: string }> = {}

    // --- Phase 1: write event A, open tailer (offset starts at 0 — fresh file) ---
    const lineA = makeEventLine('event-A')
    writeFileSync(filePath, lineA + '\n', 'utf-8')

    const state = _makeStateForTest(filePath)
    // Poll 1: opens the file. Because there's no saved cursor, it seeks to EOF.
    // We want to start from 0 so we can ship A. Force that by pre-setting offset.
    await _pollOnceForTest(state, cursors)
    // fd is now open; override the offset to 0 so the next poll reads from start.
    state.offset = 0

    // Poll 2: reads event A from offset 0.
    await _pollOnceForTest(state, cursors)
    expect(shipped.map((r) => r.msg)).toContain('event-A')
    const _afterA = shipped.length

    // --- Phase 2: write event B (orphaned tail), rename, write event C in new file ---
    const lineB = makeEventLine('orphaned-tail-B')
    appendFileSync(filePath, lineB + '\n', 'utf-8')

    // Rename — the held fd in state still points at the renamed inode (macOS/Linux: rename preserves inode).
    renameSync(filePath, rotatedPath)

    // Verify: the held fd inode ≠ the inode at filePath (which is now gone).
    // Write new file at original path containing event C.
    const lineC = makeEventLine('new-file-C')
    writeFileSync(filePath, lineC + '\n', 'utf-8')

    // --- Phase 3: poll — rename detected, drainFd ships B, state resets ---
    await _pollOnceForTest(state, cursors)

    // B must have shipped (drainFd ran).
    const msgs = shipped.map((r) => r.msg)
    expect(msgs).toContain('orphaned-tail-B')

    // B must appear before any C (drain happens before the state resets).
    const idxB = msgs.indexOf('orphaned-tail-B')
    const idxC = msgs.indexOf('new-file-C')
    // C may not have shipped yet (new file opens on the *next* poll), but B must have shipped.
    if (idxC !== -1) {
      expect(idxB).toBeLessThan(idxC)
    }

    // State must be reset for the new file (fd closed, offset 0).
    expect(state.fd).toBe(-1)
    expect(state.offset).toBe(0)

    // --- Phase 4: poll — opens new file and ships C ---
    // Poll opens the new file (fd = -1 → open path), seeking to EOF since no cursor.
    await _pollOnceForTest(state, cursors)
    state.offset = 0 // reset to read from start (as we did for A)
    await _pollOnceForTest(state, cursors)

    expect(shipped.map((r) => r.msg)).toContain('new-file-C')

    // Cleanup: close the held fd to avoid fd leaks.
    _closeFdForTest(state)
  })
})

describe('Truncate-in-place (E1b)', () => {
  /**
   * RED-proof reasoning
   * -------------------
   * pollFile step 4: when fdInfo.size < state.offset (same fd, same inode),
   * state.offset resets to 0 and remainder is cleared. The next read then
   * starts from byte 0 of the same file, picking up the new content.
   *
   * If the truncate reset is missing, state.offset stays > size, the size===offset
   * guard fires, and nothing is read from the truncated file. The assertion
   * `expect(msgs).toContain('after-truncate')` would fail.
   */
  let tmpPath: string
  const shipped: EgressRecord[] = []

  beforeEach(() => {
    tmpPath = mkdtempSync(join(tmpdir(), 'ion-e1b-'))
    shipped.length = 0
    _setShipFnForTest((rec) => { shipped.push(rec) })
  })

  afterEach(() => {
    _restoreShipFnForTest()
  })

  it('re-ships from offset 0 after truncate-in-place', async () => {
    const filePath = join(tmpPath, 'engine.jsonl')
    const cursors: Record<string, { offset: number; fileId: string }> = {}

    // Write event A and tail it.
    const lineA = makeEventLine('before-truncate')
    writeFileSync(filePath, lineA + '\n', 'utf-8')

    const state = _makeStateForTest(filePath)
    await _pollOnceForTest(state, cursors) // opens, seeks to EOF
    state.offset = 0
    await _pollOnceForTest(state, cursors) // reads event A
    expect(shipped.map((r) => r.msg)).toContain('before-truncate')

    // Truncate the file in place and write new content (same inode, smaller size).
    truncateSync(filePath, 0)
    const lineB = makeEventLine('after-truncate')
    writeFileSync(filePath, lineB + '\n', 'utf-8')

    // state.offset is now > file size → truncate detection should reset it.
    await _pollOnceForTest(state, cursors)

    expect(shipped.map((r) => r.msg)).toContain('after-truncate')

    _closeFdForTest(state)
  })
})

describe('Single-flight poll guard (E1c)', () => {
  /**
   * RED-proof reasoning
   * -------------------
   * pollFile is a chain of async fs callbacks plus the recursive drainFd loop;
   * a pass can outlast the 2s poll interval on a slow disk or a large drain. The
   * interval fires regardless, so without a single-flight guard two passes run
   * concurrently and mutate the shared state.fd / state.offset. One pass can
   * close(fd)→fd=-1 while another's read(fd) is still queued, producing
   * `RangeError [ERR_OUT_OF_RANGE]: fd ... Received -1` inside drainFd/read
   * (the packaged-app crash this fixes).
   *
   * The guard sets state.polling for the duration of a pass and skips any pass
   * that starts while one is in flight. These tests pin that contract:
   *   1. A pass entered while state.polling=true is a no-op (no open, no ship)
   *      and still resolves its callback (the driver promise never hangs).
   *   2. Two passes fired concurrently against one state ship each line exactly
   *      once — the second is skipped, not run in parallel. On the unguarded
   *      code both passes read from the same offset and double-ship.
   */
  let tmpPath: string
  const shipped: EgressRecord[] = []

  beforeEach(() => {
    tmpPath = mkdtempSync(join(tmpdir(), 'ion-e1c-'))
    shipped.length = 0
    _setShipFnForTest((rec) => { shipped.push(rec) })
  })

  afterEach(() => {
    _restoreShipFnForTest()
  })

  it('skips a poll pass entered while another is in flight', async () => {
    const filePath = join(tmpPath, 'engine.jsonl')
    const cursors: Record<string, { offset: number; fileId: string }> = {}
    writeFileSync(filePath, makeEventLine('should-not-ship') + '\n', 'utf-8')

    const state = _makeStateForTest(filePath)
    // Simulate a pass already in flight.
    state.polling = true

    // This pass must short-circuit: no fd opened, nothing shipped, callback still
    // resolves (so _pollOnceForTest doesn't hang).
    await _pollOnceForTest(state, cursors)

    expect(shipped).toHaveLength(0)
    expect(state.fd).toBe(-1)
    // The skipped pass must not clear a flag it didn't set.
    expect(state.polling).toBe(true)
  })

  it('ships each line exactly once when two passes race on one state', async () => {
    const filePath = join(tmpPath, 'engine.jsonl')
    const cursors: Record<string, { offset: number; fileId: string }> = {}
    writeFileSync(filePath, makeEventLine('event-A') + '\n', 'utf-8')

    const state = _makeStateForTest(filePath)
    await _pollOnceForTest(state, cursors) // opens, seeks to EOF
    state.offset = 0                        // rewind so the next read ships A

    // Fire two passes without awaiting the first — mimics the interval firing
    // again before the prior pass finished. The guard must let only one run.
    const p1 = _pollOnceForTest(state, cursors)
    const p2 = _pollOnceForTest(state, cursors)
    await Promise.all([p1, p2])

    const count = shipped.filter((r) => r.msg === 'event-A').length
    expect(count).toBe(1)
    expect(state.polling).toBe(false) // flag released after the pass completes

    _closeFdForTest(state)
  })
})

