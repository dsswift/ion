/**
 * diagnostics-seq-cursor.test.ts
 *
 * Pinning test for the client diagnostic-log cursor: seq-based, exactly-once.
 *
 * Verifies:
 * 1. deviceSeqMark is exported and tracks the per-client seq cursor
 * 2. handleDiagnosticLogsResponse advances the cursor to the response's nextSeq
 * 3. diagnosticLogCursor reads back the persisted cursor (never resets to 0),
 *    which is what the next request asks from — see
 *    `src/thin-view/client-log-request.ts` for the asking half
 * 4. a reconnect at the same cursor appends ZERO duplicate lines (dedup on seq)
 * 5. a nextSeq BELOW the mark (client seq-space reset: reinstall/wipe) resets
 *    the mark to nextSeq and persists the accompanying lines instead of
 *    dropping them
 *
 * Failure modes before the fixes:
 * - the cursor was a line COUNT reset to 0 on every reconnect, so each reconnect
 *   re-appended the client's whole retained history (double-count).
 * - a client whose seq space regressed (mark 449439, reported nextSeq 435499)
 *   was stuck: the mark pointed beyond anything it would ever send, and the
 *   server kept asking every 5s forever.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module mocks ───────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}))

vi.mock('../../../state', () => ({ state: {} }))

// existsSync=false so getSeqMark starts each run from an empty persisted store;
// appendFileSync captures written payloads for the dedup assertion.
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  appendFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 0 })),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

// Seq-mark persistence is a no-op in tests (the in-memory Map is the source of truth).
vi.mock('../../../utils/atomicWrite', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}))

import { appendFileSync, writeFileSync } from 'fs'
import { warn as mockWarn } from '../../../logger'
import {
  deviceSeqMark,
  diagnosticLogCursor,
  handleDiagnosticLogsResponse,
  PERIODIC_LOG_PULL_INTERVAL_MS,
} from '../diagnostics'

function iosLine(seq: number, msg = 'x'): string {
  return JSON.stringify({ ts: '2024-11-15T22:04:05Z', level: 'INFO', component: 'ios', tag: 't', msg, fields: { seq: String(seq) } })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PERIODIC_LOG_PULL_INTERVAL_MS', () => {
  it('is ~5s (within ±1s)', () => {
    expect(PERIODIC_LOG_PULL_INTERVAL_MS).toBeGreaterThanOrEqual(4_000)
    expect(PERIODIC_LOG_PULL_INTERVAL_MS).toBeLessThanOrEqual(6_000)
  })
})

describe('deviceSeqMark — per-client seq cursor', () => {
  beforeEach(() => {
    deviceSeqMark.clear()
    vi.clearAllMocks()
  })

  it('is exported as a Map', () => {
    expect(deviceSeqMark).toBeInstanceOf(Map)
  })

  it('handleDiagnosticLogsResponse advances the cursor to nextSeq', () => {
    deviceSeqMark.set('dev-2', 100)
    const logs = `${iosLine(101)}\n${iosLine(102)}\n${iosLine(103)}\n`
    handleDiagnosticLogsResponse({ type: 'desktop_diagnostic_logs_response', logs, pairingId: 'pairing-dev-2', nextSeq: 104 } as any, 'dev-2')
    expect(deviceSeqMark.get('dev-2')).toBe(104)
  })

  it('warns when the device withheld lines that carry no pairing id', () => {
    // Field evidence: every pull returned zero lines while nextSeq climbed by
    // hundreds, because the device wrote lines with no pairing_id and its
    // export skipped all of them. Nothing on this side said so.
    deviceSeqMark.set('dev-w', 100)
    handleDiagnosticLogsResponse({
      type: 'desktop_diagnostic_logs_response', logs: '', pairingId: 'pairing-w', nextSeq: 400, withheldUnstamped: 300,
    }, 'dev-w')
    expect(mockWarn).toHaveBeenCalledWith(
      'main',
      expect.stringContaining('withheld lines that carry no pairing id'),
      expect.objectContaining({ device_id: 'dev-w', withheld_unstamped: 300 }),
    )
  })

  it('does not warn for another pairing\'s lines or for a clean empty pull', () => {
    deviceSeqMark.set('dev-q', 100)
    handleDiagnosticLogsResponse({
      type: 'desktop_diagnostic_logs_response', logs: '', pairingId: 'pairing-q', nextSeq: 120, withheldOtherPairing: 20,
    }, 'dev-q')
    handleDiagnosticLogsResponse({
      type: 'desktop_diagnostic_logs_response', logs: '', pairingId: 'pairing-q', nextSeq: 120,
    }, 'dev-q')
    expect(mockWarn).not.toHaveBeenCalled()
  })

  it('resets the cursor when the device seq space regresses (nextSeq < mark)', () => {
    // Field evidence: persisted mark 449439 while device reported nextSeq 435499
    // (reinstall/reset). Old behavior kept the stale mark forever; new behavior
    // resets to the device's actual position and logs a WARN.
    deviceSeqMark.set('dev-3', 449439)
    handleDiagnosticLogsResponse({ type: 'desktop_diagnostic_logs_response', logs: '', pairingId: 'pairing-dev-3', nextSeq: 435499 } as any, 'dev-3')
    expect(deviceSeqMark.get('dev-3')).toBe(435499)
    expect(mockWarn).toHaveBeenCalledWith(
      'main',
      expect.stringContaining('seq space regressed'),
      expect.objectContaining({ device_id: 'dev-3', old_mark: 449439, reported_next_seq: 435499 }),
    )
  })

  it('persists the lines shipped alongside a seq-space regression (no dedup drop)', () => {
    // A reset device sends lines whose seqs are BELOW the stale mark. They must
    // be written, not dropped as "duplicates" against the old seq space.
    deviceSeqMark.set('dev-3b', 449439)
    const logs = `${iosLine(1)}\n${iosLine(2)}\n`
    handleDiagnosticLogsResponse({ type: 'desktop_diagnostic_logs_response', logs, pairingId: 'pairing-dev-3b', nextSeq: 3 } as any, 'dev-3b')
    expect(deviceSeqMark.get('dev-3b')).toBe(3)
    expect(writeFileSync).toHaveBeenCalledOnce()
    const [, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]
    expect((content as string).split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('keeps the cursor when the lines fail to save, so the next pull asks for them again', () => {
    // The device deletes lines once the server asks from past them. Advancing
    // over lines that never reached disk would make that delete a real loss.
    deviceSeqMark.set('dev-f', 100)
    ;(writeFileSync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('ENOSPC') })
    const logs = `${iosLine(101)}\n${iosLine(102)}\n`
    handleDiagnosticLogsResponse({ type: 'desktop_diagnostic_logs_response', logs, pairingId: 'pairing-f', nextSeq: 102 }, 'dev-f')
    expect(deviceSeqMark.get('dev-f')).toBe(100)
    expect(mockWarn).toHaveBeenCalledWith('main', expect.stringContaining('persist failed'), expect.objectContaining({ count: 2 }))
  })

  it('resets a regressed cursor to 0 when the lines fail to save', () => {
    deviceSeqMark.set('dev-fr', 449439)
    ;(writeFileSync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('ENOSPC') })
    const logs = `${iosLine(1)}\n${iosLine(2)}\n`
    handleDiagnosticLogsResponse({ type: 'desktop_diagnostic_logs_response', logs, pairingId: 'pairing-fr', nextSeq: 2 }, 'dev-fr')
    expect(deviceSeqMark.get('dev-fr')).toBe(0)
  })

  it('diagnosticLogCursor resumes from the persisted cursor (does NOT reset to 0)', () => {
    deviceSeqMark.set('dev-1', 500)
    // Reading the cursor never moves it: the next request asks from 500.
    expect(diagnosticLogCursor('dev-1')).toBe(500)
    expect(deviceSeqMark.get('dev-1')).toBe(500)
  })

  it('diagnosticLogCursor answers 0 for a client it has never heard from', () => {
    expect(diagnosticLogCursor('dev-never')).toBe(0)
  })

  it('a reconnect at the same cursor appends ZERO duplicate lines (exactly-once)', () => {
    // First pull: seqs 1..3, cursor advances to 4.
    const first = `${iosLine(1)}\n${iosLine(2)}\n${iosLine(3)}\n`
    handleDiagnosticLogsResponse({ type: 'desktop_diagnostic_logs_response', logs: first, pairingId: 'pairing-x', nextSeq: 4 } as any, 'dev-x')
    expect(deviceSeqMark.get('dev-x')).toBe(4)
    ;(appendFileSync as ReturnType<typeof vi.fn>).mockClear()
    ;(writeFileSync as ReturnType<typeof vi.fn>).mockClear()

    // Reconnect edge case: the device re-sends seqs 1..3 (already persisted). The
    // desktop must drop all three as duplicates and write nothing.
    handleDiagnosticLogsResponse({ type: 'desktop_diagnostic_logs_response', logs: first, pairingId: 'pairing-x', nextSeq: 4 } as any, 'dev-x')
    expect(appendFileSync).not.toHaveBeenCalled()
    expect(writeFileSync).not.toHaveBeenCalled()
  })
})
