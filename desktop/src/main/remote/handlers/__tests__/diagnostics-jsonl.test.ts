import { describe, it, expect, vi, beforeEach } from 'vitest'
import { appendFileSync, writeFileSync, existsSync, statSync, renameSync, unlinkSync } from 'fs'

// We'll test the persistLogs behavior by mocking fs and verifying
// the written content is the raw JSONL bytes without a header.

vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  // Default: file does not exist — so writeFileSync is called, not appendFileSync.
  // Individual tests may override this to simulate an existing file.
  existsSync: vi.fn(() => false),
  // Default: file is small — no rotation triggered.
  statSync: vi.fn(() => ({ size: 0 })),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

vi.mock('../../../logger', () => ({
  log: vi.fn(),
}))

vi.mock('../../../state', () => ({
  state: { remoteTransport: null },
}))

describe('diagnostics persistLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset existsSync to default (file does not exist) before each test.
    ;(existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false)
  })

  it('writes raw JSONL bytes without a header', async () => {
    // Import after mocks are set up
    const { handleDiagnosticLogsResponse } = await import('../diagnostics')

    const line1 = JSON.stringify({
      ts: '2024-11-15T22:04:05.123456789Z',
      level: 'INFO',
      component: 'ios',
      tag: 'session',
      msg: 'session started',
      fields: {},
    })
    const line2 = JSON.stringify({
      ts: '2024-11-15T22:04:06.000000000Z',
      level: 'DEBUG',
      component: 'ios',
      tag: 'ipc',
      msg: 'CMD: sync',
      fields: {},
    })
    const rawLogs = `${line1}\n${line2}\n`

    // Trigger handleDiagnosticLogsResponse with a fake command
    handleDiagnosticLogsResponse(
      { type: 'desktop_diagnostic_logs_response', logs: rawLogs, deviceId: 'device-001', deviceName: 'Test iPhone' },
      'device-001',
    )

    // writeFileSync should have been called once (file didn't exist)
    expect(writeFileSync).toHaveBeenCalledOnce()
    const [filePath, content, encoding] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]

    // File path must end with .jsonl
    expect(filePath).toMatch(/ios-diagnostic-logs\.jsonl$/)

    // Content must be exactly the raw logs — no header, no modification
    expect(content).toBe(rawLogs)
    expect(encoding).toBe('utf-8')

    // Verify JSONL line integrity: each line parses as JSON
    const lines = (content as string).split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
      const obj = JSON.parse(line) as Record<string, unknown>
      expect(obj.component).toBe('ios')
      expect(obj.level).toBeTruthy()
      expect(obj.ts).toBeTruthy()
    }
  })

  it('does not prepend a txt header', async () => {
    const { handleDiagnosticLogsResponse } = await import('../diagnostics')

    const singleLine = JSON.stringify({ ts: '2024-11-15T22:04:05Z', level: 'INFO', component: 'ios', msg: 'hi', fields: {} })

    handleDiagnosticLogsResponse(
      { type: 'desktop_diagnostic_logs_response', logs: singleLine + '\n', deviceId: 'device-002', deviceName: 'iPhone' },
      'device-002',
    )

    const [, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]
    // Must NOT start with a '#' comment header
    expect((content as string).startsWith('#')).toBe(false)
    // Must start with a JSON object
    expect((content as string).trimStart().startsWith('{')).toBe(true)
  })

  it('appends to existing file on subsequent pulls', async () => {
    // Simulate file already existing so appendFileSync is called instead.
    ;(existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)

    const { handleDiagnosticLogsResponse } = await import('../diagnostics')

    const singleLine = JSON.stringify({ ts: '2024-11-15T22:04:05Z', level: 'INFO', component: 'ios', msg: 'append test', fields: {} })

    handleDiagnosticLogsResponse(
      { type: 'desktop_diagnostic_logs_response', logs: singleLine + '\n', deviceId: 'device-003', deviceName: 'iPhone' },
      'device-003',
    )

    // appendFileSync must be called when the file exists; writeFileSync must not.
    expect(appendFileSync).toHaveBeenCalledOnce()
    expect(writeFileSync).not.toHaveBeenCalled()
    const [filePath, content, encoding] = (appendFileSync as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(filePath).toMatch(/ios-diagnostic-logs\.jsonl$/)
    expect(content).toBe(singleLine + '\n')
    expect(encoding).toBe('utf-8')
  })
})

describe('diagnostics rotateIosLogIfNeeded', () => {
  const IOS_LOG_MAX_BYTES = 10 * 1024 * 1024 // 10 MB — must match diagnostics.ts constant

  beforeEach(() => {
    vi.clearAllMocks()
    ;(existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)
    // Default: file is under the cap — no rotation.
    ;(statSync as ReturnType<typeof vi.fn>).mockReturnValue({ size: 0 })
  })

  it('does not rotate when file is under the cap', async () => {
    ;(statSync as ReturnType<typeof vi.fn>).mockReturnValue({ size: IOS_LOG_MAX_BYTES - 1 })
    const { handleDiagnosticLogsResponse } = await import('../diagnostics')
    const singleLine = JSON.stringify({ ts: '2024-11-15T22:04:05Z', level: 'INFO', component: 'ios', msg: 'small', fields: {} })
    handleDiagnosticLogsResponse(
      { type: 'desktop_diagnostic_logs_response', logs: singleLine + '\n', deviceId: 'dev-small', deviceName: 'iPhone' },
      'dev-small',
    )
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled()
  })

  it('renames live file to .1 when file exceeds the cap', async () => {
    ;(statSync as ReturnType<typeof vi.fn>).mockReturnValue({ size: IOS_LOG_MAX_BYTES + 1 })
    const { handleDiagnosticLogsResponse } = await import('../diagnostics')
    const singleLine = JSON.stringify({ ts: '2024-11-15T22:04:05Z', level: 'INFO', component: 'ios', msg: 'big', fields: {} })
    handleDiagnosticLogsResponse(
      { type: 'desktop_diagnostic_logs_response', logs: singleLine + '\n', deviceId: 'dev-big', deviceName: 'iPhone' },
      'dev-big',
    )
    const renameCalls = vi.mocked(renameSync).mock.calls.map(([src, dst]) => [String(src), String(dst)])
    const promoted = renameCalls.find(([, dst]) => dst.endsWith('ios-diagnostic-logs.jsonl.1'))
    expect(promoted).toBeDefined()
    // Source must be the live file (no suffix).
    expect(promoted![0]).toMatch(/ios-diagnostic-logs\.jsonl$/)
  })

  it('shifts .1→.2 before renaming live to .1', async () => {
    ;(statSync as ReturnType<typeof vi.fn>).mockReturnValue({ size: IOS_LOG_MAX_BYTES + 1 })
    const { handleDiagnosticLogsResponse } = await import('../diagnostics')
    const singleLine = JSON.stringify({ ts: '2024-11-15T22:04:05Z', level: 'INFO', component: 'ios', msg: 'shift', fields: {} })
    handleDiagnosticLogsResponse(
      { type: 'desktop_diagnostic_logs_response', logs: singleLine + '\n', deviceId: 'dev-shift', deviceName: 'iPhone' },
      'dev-shift',
    )
    const renameCalls = vi.mocked(renameSync).mock.calls.map(([src, dst]) => [String(src), String(dst)])
    const shiftIdx = renameCalls.findIndex(([src, dst]) =>
      src.endsWith('.1') && dst.endsWith('.2'),
    )
    const promoteIdx = renameCalls.findIndex(([src, dst]) =>
      src.match(/ios-diagnostic-logs\.jsonl$/) && dst.endsWith('.1'),
    )
    expect(shiftIdx).toBeGreaterThanOrEqual(0)
    expect(promoteIdx).toBeGreaterThan(shiftIdx)
  })

  it('unlinks the oldest generation (.2) before shifting', async () => {
    ;(statSync as ReturnType<typeof vi.fn>).mockReturnValue({ size: IOS_LOG_MAX_BYTES + 1 })
    const { handleDiagnosticLogsResponse } = await import('../diagnostics')
    const singleLine = JSON.stringify({ ts: '2024-11-15T22:04:05Z', level: 'INFO', component: 'ios', msg: 'prune', fields: {} })
    handleDiagnosticLogsResponse(
      { type: 'desktop_diagnostic_logs_response', logs: singleLine + '\n', deviceId: 'dev-prune', deviceName: 'iPhone' },
      'dev-prune',
    )
    const unlinkPaths = vi.mocked(unlinkSync).mock.calls.map(([p]) => String(p))
    expect(unlinkPaths.some((p) => p.endsWith('ios-diagnostic-logs.jsonl.2'))).toBe(true)
  })
})
