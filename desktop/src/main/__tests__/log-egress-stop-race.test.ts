/**
 * log-egress-stop-race.test.ts — Stop-while-polling safety (E1d).
 *
 * Coverage:
 *   D1  fstatErr path guards close(fd) when stopTailer already set fd=-1.
 *   D2  Poll recovers to open-path after external fd close without crashing.
 *
 * Background
 * ----------
 * stopTailer closes state.fd and sets state.fd=-1 immediately, without
 * checking state.polling. If a poll pass is in flight, its async callbacks
 * (fstat, stat, read) fire after stopTailer returns and see state.fd=-1.
 * Without the guards added in this fix, those callbacks pass -1 to close()
 * or read(), throwing ERR_OUT_OF_RANGE — the same class of crash as the
 * interval-race fixed in E1c. The guards in log-egress-tailer.ts close only
 * when state.fd >= 0 and bail out of the Step-5 read when state.fd < 0.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdtempSync, writeFileSync, closeSync } from 'fs'
import { tmpdir } from 'os'

// ---------------------------------------------------------------------------
// Module mock setup — isolate HOME before any egress module is imported.
// ---------------------------------------------------------------------------

import { vi } from 'vitest'

vi.hoisted(() => {
  const os = require('os') as typeof import('os')
  const fs = require('fs') as typeof import('fs')
  const p = require('path') as typeof import('path')
  const home = fs.mkdtempSync(p.join(os.tmpdir(), 'ion-egress-home-stop-race-'))
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
  _makeStateForTest,
  _pollOnceForTest,
  _closeFdForTest,
  _setShipFnForTest,
  _restoreShipFnForTest,
} from '../log-egress-tailer'
import type { EgressRecord } from '../log-egress'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// E1d tests
// ---------------------------------------------------------------------------

describe('Stop-while-polling safety (E1d)', () => {
  /**
   * RED-proof reasoning
   * -------------------
   * The shutdown-race has the same shape as the interval-race (E1c) but a
   * different trigger: stopTailer() rather than a concurrent interval tick.
   *
   *   D1: The in-flight pass has called fstat(state.fd) and is awaiting the
   *       callback. stopTailer fires: _closeFdForTest closes the OS fd and sets
   *       state.fd=-1. The fstat callback fires with an error (invalid fd).
   *       Without the guard, the fstatErr branch calls close(state.fd=-1) →
   *       ERR_OUT_OF_RANGE. With the guard, it checks state.fd>=0 first and
   *       skips the close call, then sets state.fd=-1 and finishes cleanly.
   *
   *   D2: Similar scenario but the pass completed and re-opened the fd. A
   *       subsequent stopTailer-equivalent (_closeFdForTest) sets state.fd=-1.
   *       The next poll must enter the open-path (state.fd<0 branch at step 1)
   *       and not crash — no read(-1) or close(-1) is issued.
   */
  let tmpPath: string
  const shipped: EgressRecord[] = []

  beforeEach(() => {
    tmpPath = mkdtempSync(join(tmpdir(), 'ion-e1d-'))
    shipped.length = 0
    _setShipFnForTest((rec) => { shipped.push(rec) })
  })

  afterEach(() => {
    _restoreShipFnForTest()
  })

  it('D1: fstatErr path guards close(fd) when fd already closed externally', async () => {
    const filePath = join(tmpPath, 'engine.jsonl')
    writeFileSync(filePath, makeEventLine('event-d1') + '\n', 'utf-8')
    const cursors: Record<string, { offset: number; fileId: string }> = {}
    const state = _makeStateForTest(filePath)

    // Open the file via a normal poll pass (fd<0 → open-path).
    await _pollOnceForTest(state, cursors)
    expect(state.fd).toBeGreaterThanOrEqual(0)

    // Simulate the OS closing the fd (e.g., process shutdown or fd limit):
    // close the underlying fd at the OS level WITHOUT zeroing state.fd. This
    // leaves state.fd pointing to an invalid (recycled) fd number, so fstat
    // inside the next poll fires and errors — triggering the fstatErr branch
    // with a stale (positive) state.fd. Without the guard, that branch calls
    // close(state.fd) on the already-closed fd → ERR_EBADF / ERR_OUT_OF_RANGE.
    const staleFd = state.fd
    closeSync(staleFd) // close OS fd, leave state.fd intact

    // Must resolve without throwing.
    await expect(_pollOnceForTest(state, cursors)).resolves.toBeUndefined()
    // fstatErr branch must have set state.fd=-1 so the next poll re-opens cleanly.
    expect(state.fd).toBe(-1)
  })

  it('D2: poll recovers to open-path after external fd close without crashing', async () => {
    const filePath = join(tmpPath, 'engine.jsonl')
    writeFileSync(filePath, makeEventLine('event-d2') + '\n', 'utf-8')
    const cursors: Record<string, { offset: number; fileId: string }> = {}
    const state = _makeStateForTest(filePath)

    // First poll: opens the file.
    await _pollOnceForTest(state, cursors)
    expect(state.fd).toBeGreaterThanOrEqual(0)

    // stopTailer simulation.
    _closeFdForTest(state)

    // Next poll: state.fd=-1 → open-path. No close(-1) or read(-1) issued.
    await expect(_pollOnceForTest(state, cursors)).resolves.toBeUndefined()

    // Cleanup any fd the recovery poll opened.
    _closeFdForTest(state)
  })
})
