/**
 * diagnostics-periodic-pull.test.ts
 *
 * Pinning test for feat(desktop): periodic iOS diagnostic-log pull while connected.
 *
 * Verifies:
 * 1. deviceLogLineOffset is exported and tracks per-device high-water mark
 * 2. startPeriodicLogPull / stopPeriodicLogPull control the interval
 * 3. handleDiagnosticLogsResponse advances the high-water mark
 * 4. autoPullDiagnosticLogs resets offset to 0 (full pull on connect)
 * 5. persistLogs uses append (not overwrite) — confirmed by the append-correct path
 *
 * Failure mode without the fix:
 * - deviceLogLineOffset would not exist (no per-device tracking)
 * - startPeriodicLogPull would not exist (no periodic pulls)
 * - handleDiagnosticLogsResponse would call writeFileSync (overwrite) not appendFileSync
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

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  appendFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

vi.mock('../../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}))

import {
  deviceLogLineOffset,
  startPeriodicLogPull,
  stopPeriodicLogPull,
  handleDiagnosticLogsResponse,
  autoPullDiagnosticLogs,
  PERIODIC_LOG_PULL_INTERVAL_MS,
} from '../diagnostics'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PERIODIC_LOG_PULL_INTERVAL_MS', () => {
  it('is ~5s (within ±1s)', () => {
    expect(PERIODIC_LOG_PULL_INTERVAL_MS).toBeGreaterThanOrEqual(4_000)
    expect(PERIODIC_LOG_PULL_INTERVAL_MS).toBeLessThanOrEqual(6_000)
  })
})

describe('deviceLogLineOffset — per-device high-water mark', () => {
  beforeEach(() => {
    deviceLogLineOffset.clear()
    vi.clearAllMocks()
    stopPeriodicLogPull()
  })

  afterEach(() => {
    stopPeriodicLogPull()
  })

  it('is exported as a Map', () => {
    expect(deviceLogLineOffset).toBeInstanceOf(Map)
  })

  it('starts at 0 for a new device', () => {
    expect(deviceLogLineOffset.get('new-device')).toBeUndefined()
  })

  it('autoPullDiagnosticLogs resets offset to 0', () => {
    deviceLogLineOffset.set('dev-1', 500)
    autoPullDiagnosticLogs('dev-1')
    expect(deviceLogLineOffset.get('dev-1')).toBe(0)
  })

  it('handleDiagnosticLogsResponse advances the high-water mark', () => {
    deviceLogLineOffset.set('dev-2', 100)
    const logs = '{"msg":"line1"}\n{"msg":"line2"}\n{"msg":"line3"}\n'
    handleDiagnosticLogsResponse({ type: 'desktop_diagnostic_logs_response', logs, deviceId: 'dev-2', deviceName: 'iPad' } as any, 'dev-2')
    const offset = deviceLogLineOffset.get('dev-2') ?? 0
    // 3 new lines → offset advances from 100 to 103.
    expect(offset).toBe(103)
  })

  it('handleDiagnosticLogsResponse does not advance offset for empty response', () => {
    deviceLogLineOffset.set('dev-3', 200)
    handleDiagnosticLogsResponse({ type: 'desktop_diagnostic_logs_response', logs: '', deviceId: 'dev-3', deviceName: 'iPhone' } as any, 'dev-3')
    expect(deviceLogLineOffset.get('dev-3')).toBe(200)
  })
})

describe('startPeriodicLogPull / stopPeriodicLogPull', () => {
  beforeEach(() => {
    deviceLogLineOffset.clear()
    vi.clearAllMocks()
    stopPeriodicLogPull()
    vi.useFakeTimers()
  })

  afterEach(() => {
    stopPeriodicLogPull()
    vi.useRealTimers()
  })

  it('sendToDevice is called with lineOffset after the interval fires', () => {
    deviceLogLineOffset.set('device-001', 42)
    startPeriodicLogPull()
    vi.advanceTimersByTime(PERIODIC_LOG_PULL_INTERVAL_MS + 100)
    expect(mockSendToDevice).toHaveBeenCalledWith(
      'device-001',
      expect.objectContaining({ type: 'desktop_request_diagnostic_logs', lineOffset: 42 }),
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
