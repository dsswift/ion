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
 *
 * Failure mode before the fix:
 * - the cursor was a line COUNT reset to 0 on every reconnect, so each reconnect
 *   re-appended the device's whole retained history (double-count).
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
import {
  deviceSeqMark,
  startPeriodicLogPull,
  stopPeriodicLogPull,
  handleDiagnosticLogsResponse,
  autoPullDiagnosticLogs,
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

describe('deviceSeqMark — per-device seq cursor', () => {
  beforeEach(() => {
    deviceSeqMark.clear()
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
    handleDiagnosticLogsResponse({ type: 'desktop_diagnostic_logs_response', logs, deviceId: 'dev-2', deviceName: 'iPad', nextSeq: 104 } as any, 'dev-2')
    expect(deviceSeqMark.get('dev-2')).toBe(104)
  })

  it('does not move the cursor backward on a stale nextSeq', () => {
    deviceSeqMark.set('dev-3', 200)
    handleDiagnosticLogsResponse({ type: 'desktop_diagnostic_logs_response', logs: '', deviceId: 'dev-3', deviceName: 'iPhone', nextSeq: 5 } as any, 'dev-3')
    expect(deviceSeqMark.get('dev-3')).toBe(200)
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
    handleDiagnosticLogsResponse({ type: 'desktop_diagnostic_logs_response', logs: first, deviceId: 'dev-x', deviceName: 'iPhone', nextSeq: 4 } as any, 'dev-x')
    expect(deviceSeqMark.get('dev-x')).toBe(4)
    ;(appendFileSync as ReturnType<typeof vi.fn>).mockClear()
    ;(writeFileSync as ReturnType<typeof vi.fn>).mockClear()

    // Reconnect edge case: the device re-sends seqs 1..3 (already persisted). The
    // desktop must drop all three as duplicates and write nothing.
    handleDiagnosticLogsResponse({ type: 'desktop_diagnostic_logs_response', logs: first, deviceId: 'dev-x', deviceName: 'iPhone', nextSeq: 4 } as any, 'dev-x')
    expect(appendFileSync).not.toHaveBeenCalled()
    expect(writeFileSync).not.toHaveBeenCalled()
  })
})

describe('startPeriodicLogPull / stopPeriodicLogPull', () => {
  beforeEach(() => {
    deviceSeqMark.clear()
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
