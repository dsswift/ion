/**
 * diagnostics-periodic-pull.test.ts
 *
 * Pinning test for the iOS diagnostic-log pull: seq-based, exactly-once.
 *
 * Verifies:
 * 1. deviceSeqMark is exported and tracks the per-device seq cursor
 * 2. startPeriodicLogPull / stopPeriodicLogPull control the interval
 * 3. handleDiagnosticLogsResponse advances the cursor to the response's nextSeq
 * 4. autoPullDiagnosticLogs resumes from the persisted cursor (never resets to 0)
 * 5. a reconnect at the same cursor appends ZERO duplicate lines (dedup on seq)
 * 6. a nextSeq BELOW the mark (device seq-space reset: reinstall/wipe) resets the
 *    mark to nextSeq and persists the accompanying lines instead of dropping them
 * 7. unresponsive devices back off exponentially (skip ticks) and reset on response
 *
 * Failure modes before the fixes:
 * - the cursor was a line COUNT reset to 0 on every reconnect, so each reconnect
 *   re-appended the device's whole retained history (double-count).
 * - a device whose seq space regressed (mark 449439, reported nextSeq 435499) was
 *   stuck: the mark pointed beyond anything the device would ever send, and the
 *   desktop kept asking every 5s forever.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Module mocks ───────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}))

const { mockSendToDevice } = vi.hoisted(() => ({
  mockSendToDevice: vi.fn(),
}))

vi.mock('../../../state', () => ({
  state: {
    remoteTransport: {
      sendToDevice: mockSendToDevice,
      getConnectedDeviceIds: vi.fn(() => ['device-001']),
    },
  },
}))

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
import { warn as mockWarn, debug as mockDebug } from '../../../logger'
import {
  deviceSeqMark,
  devicePullBackoff,
  startPeriodicLogPull,
  stopPeriodicLogPull,
  handleDiagnosticLogsResponse,
  autoPullDiagnosticLogs,
  PERIODIC_LOG_PULL_INTERVAL_MS,
  LOG_PULL_NO_RESPONSE_THRESHOLD,
  LOG_PULL_BACKOFF_MAX_MS,
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

describe('deviceSeqMark — per-device seq cursor', () => {
  beforeEach(() => {
    deviceSeqMark.clear()
    devicePullBackoff.clear()
    vi.clearAllMocks()
    stopPeriodicLogPull()
  })

  afterEach(() => {
    stopPeriodicLogPull()
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

  it('autoPullDiagnosticLogs resumes from the persisted cursor (does NOT reset to 0)', () => {
    deviceSeqMark.set('dev-1', 500)
    autoPullDiagnosticLogs('dev-1')
    // Cursor is untouched, and the outgoing request carries sinceSeq=500.
    expect(deviceSeqMark.get('dev-1')).toBe(500)
    expect(mockSendToDevice).toHaveBeenCalledWith(
      'dev-1',
      expect.objectContaining({ type: 'desktop_request_diagnostic_logs', sinceSeq: 500 }),
    )
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

describe('startPeriodicLogPull / stopPeriodicLogPull', () => {
  beforeEach(() => {
    deviceSeqMark.clear()
    devicePullBackoff.clear()
    vi.clearAllMocks()
    stopPeriodicLogPull()
    vi.useFakeTimers()
  })

  afterEach(() => {
    stopPeriodicLogPull()
    vi.useRealTimers()
  })

  it('sendToDevice is called with sinceSeq after the interval fires', () => {
    deviceSeqMark.set('device-001', 42)
    startPeriodicLogPull()
    vi.advanceTimersByTime(PERIODIC_LOG_PULL_INTERVAL_MS + 100)
    expect(mockSendToDevice).toHaveBeenCalledWith(
      'device-001',
      expect.objectContaining({ type: 'desktop_request_diagnostic_logs', sinceSeq: 42 }),
    )
  })

  it('stopPeriodicLogPull prevents further pulls', () => {
    startPeriodicLogPull()
    stopPeriodicLogPull()
    mockSendToDevice.mockClear()
    vi.advanceTimersByTime(PERIODIC_LOG_PULL_INTERVAL_MS * 3)
    expect(mockSendToDevice).not.toHaveBeenCalled()
  })
})

describe('periodic pull backoff — unresponsive devices', () => {
  beforeEach(() => {
    deviceSeqMark.clear()
    devicePullBackoff.clear()
    vi.clearAllMocks()
    stopPeriodicLogPull()
    vi.useFakeTimers()
  })

  afterEach(() => {
    stopPeriodicLogPull()
    vi.useRealTimers()
  })

  function pullCount(): number {
    return mockSendToDevice.mock.calls.filter(
      ([, cmd]) => (cmd as { type: string }).type === 'desktop_request_diagnostic_logs',
    ).length
  }

  it('pulls at the base interval until the no-response threshold is reached', () => {
    startPeriodicLogPull()
    vi.advanceTimersByTime(PERIODIC_LOG_PULL_INTERVAL_MS * LOG_PULL_NO_RESPONSE_THRESHOLD)
    expect(pullCount()).toBe(LOG_PULL_NO_RESPONSE_THRESHOLD)
  })

  it('skips a backed-off device on subsequent ticks (exponential schedule)', () => {
    startPeriodicLogPull()
    // Ticks 1..3 pull (threshold=3). Pull 3 engages a 2x backoff window (10s):
    // the tick immediately after it must be skipped.
    vi.advanceTimersByTime(PERIODIC_LOG_PULL_INTERVAL_MS * LOG_PULL_NO_RESPONSE_THRESHOLD)
    expect(pullCount()).toBe(LOG_PULL_NO_RESPONSE_THRESHOLD)
    vi.advanceTimersByTime(PERIODIC_LOG_PULL_INTERVAL_MS)
    expect(pullCount()).toBe(LOG_PULL_NO_RESPONSE_THRESHOLD) // tick 4 skipped — inside 10s window
    // Next tick (10s after pull 3) is eligible again → pull 4, which doubles to 20s.
    vi.advanceTimersByTime(PERIODIC_LOG_PULL_INTERVAL_MS)
    expect(pullCount()).toBe(LOG_PULL_NO_RESPONSE_THRESHOLD + 1)
    // The following 3 ticks (15s) fall inside the 20s window → all skipped.
    vi.advanceTimersByTime(PERIODIC_LOG_PULL_INTERVAL_MS * 3)
    expect(pullCount()).toBe(LOG_PULL_NO_RESPONSE_THRESHOLD + 1)
    // 20s after pull 4 → pull 5.
    vi.advanceTimersByTime(PERIODIC_LOG_PULL_INTERVAL_MS)
    expect(pullCount()).toBe(LOG_PULL_NO_RESPONSE_THRESHOLD + 2)
  })

  it('caps the backoff delay at LOG_PULL_BACKOFF_MAX_MS', () => {
    startPeriodicLogPull()
    // Advance far enough that the exponential schedule has hit the cap.
    vi.advanceTimersByTime(LOG_PULL_BACKOFF_MAX_MS * 10)
    const st = devicePullBackoff.get('device-001')
    expect(st).toBeDefined()
    expect(st!.delayMs).toBe(LOG_PULL_BACKOFF_MAX_MS)
    // Once capped, exactly one pull per LOG_PULL_BACKOFF_MAX_MS window.
    const before = pullCount()
    vi.advanceTimersByTime(LOG_PULL_BACKOFF_MAX_MS)
    expect(pullCount()).toBe(before + 1)
  })

  it('a response resets eligibility to the base interval', () => {
    startPeriodicLogPull()
    // Drive the device into backoff.
    vi.advanceTimersByTime(PERIODIC_LOG_PULL_INTERVAL_MS * LOG_PULL_NO_RESPONSE_THRESHOLD)
    expect(devicePullBackoff.get('device-001')).toBeDefined()

    // Device answers — backoff state cleared, next tick pulls again.
    handleDiagnosticLogsResponse(
      { type: 'desktop_diagnostic_logs_response', logs: '', pairingId: 'pairing-001', nextSeq: 1 } as any,
      'device-001',
    )
    expect(devicePullBackoff.get('device-001')).toBeUndefined()

    const before = pullCount()
    vi.advanceTimersByTime(PERIODIC_LOG_PULL_INTERVAL_MS)
    expect(pullCount()).toBe(before + 1)
    expect(mockDebug).toHaveBeenCalledWith(
      'main',
      expect.stringContaining('backoff reset'),
      expect.objectContaining({ device_id: 'device-001' }),
    )
  })

  it('autoPullDiagnosticLogs clears stale backoff on (re)connect', () => {
    startPeriodicLogPull()
    vi.advanceTimersByTime(PERIODIC_LOG_PULL_INTERVAL_MS * (LOG_PULL_NO_RESPONSE_THRESHOLD + 1))
    expect(devicePullBackoff.get('device-001')).toBeDefined()
    autoPullDiagnosticLogs('device-001')
    expect(devicePullBackoff.get('device-001')).toBeUndefined()
  })
})
