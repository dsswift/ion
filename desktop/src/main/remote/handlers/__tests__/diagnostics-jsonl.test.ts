import { describe, it, expect, vi, beforeEach } from 'vitest'
import { appendFileSync, writeFileSync, existsSync, statSync, renameSync, unlinkSync } from 'fs'

// Tests persistLogChunk's behavior via handleDiagnosticLogsResponse: it parses
// each incoming iOS line, injects desktop-side identity (pairing_id / desktop_host)
// into fields, dedups on seq, and writes valid JSONL.
// iOS already stamps device_id (identifierForVendor UUID), device_model, app_version,
// os_version, and seq; the desktop no longer needs to inject these from the wire.

vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  // Default: LOG_FILE and SEQ_MARK_FILE do not exist. writeFileSync is called
  // (not appendFileSync); getSeqMark reads 0 (no persisted cursor).
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  statSync: vi.fn(() => ({ size: 0 })),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

// atomicWrite is a real disk write; stub it so seq-mark persistence is a no-op.
vi.mock('../../../utils/atomicWrite', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../../../logger', () => ({
  log: vi.fn(),
}))

vi.mock('../../../state', () => ({
  state: { remoteTransport: null },
}))

// Build an iOS log line with a seq (what real lines now carry).
function iosLine(seq: number, msg = 'x', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: '2024-11-15T22:04:05.123456789Z',
    level: 'INFO',
    component: 'ios',
    tag: 'session',
    msg,
    fields: { device_model: 'iPhone15,3', device_id: 'vendorUUID-abc123', app_version: '1.2.0', seq: String(seq), ...extra },
  })
}

describe('diagnostics persistLogChunk — identity injection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false)
  })

  it('injects pairing_id / desktop_host into every persisted line', async () => {
    const { handleDiagnosticLogsResponse } = await import('../diagnostics')
    const rawLogs = `${iosLine(1, 'session started')}\n${iosLine(2, 'CMD: sync')}\n`

    handleDiagnosticLogsResponse(
      { type: 'desktop_diagnostic_logs_response', logs: rawLogs, pairingId: 'device-001', nextSeq: 3 },
      'device-001',
    )

    expect(writeFileSync).toHaveBeenCalledOnce()
    const [filePath, content, encoding] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(filePath).toMatch(/ios-diagnostic-logs\.jsonl$/)
    expect(encoding).toBe('utf-8')

    const lines = (content as string).split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>
      expect(obj.component).toBe('ios')
      const fields = obj.fields as Record<string, unknown>
      // Desktop-injected identity present on every line.
      expect(fields.pairing_id).toBe('device-001')
      expect(typeof fields.desktop_host).toBe('string')
      expect((fields.desktop_host as string).length).toBeGreaterThan(0)
      // iOS-stamped identity preserved.
      expect(fields.device_id).toBe('vendorUUID-abc123')
      expect(fields.device_model).toBe('iPhone15,3')
      expect(fields.app_version).toBe('1.2.0')
    }
  })

  it('writes valid JSONL with no header prefix', async () => {
    const { handleDiagnosticLogsResponse } = await import('../diagnostics')
    handleDiagnosticLogsResponse(
      { type: 'desktop_diagnostic_logs_response', logs: iosLine(1) + '\n', pairingId: 'device-002', nextSeq: 2 },
      'device-002',
    )
    const [, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]
    expect((content as string).startsWith('#')).toBe(false)
    expect((content as string).trimStart().startsWith('{')).toBe(true)
  })

  it('appends to existing file on subsequent pulls', async () => {
    ;(existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)
    const { handleDiagnosticLogsResponse } = await import('../diagnostics')
    handleDiagnosticLogsResponse(
      { type: 'desktop_diagnostic_logs_response', logs: iosLine(1, 'append test') + '\n', pairingId: 'device-003', nextSeq: 2 },
      'device-003',
    )
    expect(appendFileSync).toHaveBeenCalledOnce()
    expect(writeFileSync).not.toHaveBeenCalled()
    const [filePath, , encoding] = (appendFileSync as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(filePath).toMatch(/ios-diagnostic-logs\.jsonl$/)
    expect(encoding).toBe('utf-8')
  })

  it('passes a malformed line through unchanged (no silent drop)', async () => {
    const { handleDiagnosticLogsResponse } = await import('../diagnostics')
    const malformed = 'this is not json'
    const good = iosLine(1)
    handleDiagnosticLogsResponse(
      { type: 'desktop_diagnostic_logs_response', logs: `${malformed}\n${good}\n`, pairingId: 'device-004', nextSeq: 2 },
      'device-004',
    )
    const [, content] = (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]
    const lines = (content as string).split('\n').filter(Boolean)
    // Both lines survive: the malformed one verbatim, the good one identity-stamped.
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(malformed)
    const goodObj = JSON.parse(lines[1]) as Record<string, unknown>
    expect((goodObj.fields as Record<string, unknown>).pairing_id).toBe('device-004')
  })
})

describe('diagnostics rotateIosLogIfNeeded', () => {
  const IOS_LOG_MAX_BYTES = 10 * 1024 * 1024 // 10 MB — must match diagnostics.ts constant

  beforeEach(() => {
    vi.clearAllMocks()
    ;(existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true)
    ;(statSync as ReturnType<typeof vi.fn>).mockReturnValue({ size: 0 })
  })

  it('does not rotate when file is under the cap', async () => {
    ;(statSync as ReturnType<typeof vi.fn>).mockReturnValue({ size: IOS_LOG_MAX_BYTES - 1 })
    const { handleDiagnosticLogsResponse } = await import('../diagnostics')
    handleDiagnosticLogsResponse(
      { type: 'desktop_diagnostic_logs_response', logs: iosLine(1, 'small') + '\n', pairingId: 'dev-small', nextSeq: 2 },
      'dev-small',
    )
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled()
  })

  it('renames live file to .1 when file exceeds the cap', async () => {
    ;(statSync as ReturnType<typeof vi.fn>).mockReturnValue({ size: IOS_LOG_MAX_BYTES + 1 })
    const { handleDiagnosticLogsResponse } = await import('../diagnostics')
    handleDiagnosticLogsResponse(
      { type: 'desktop_diagnostic_logs_response', logs: iosLine(1, 'big') + '\n', pairingId: 'dev-big', nextSeq: 2 },
      'dev-big',
    )
    const renameCalls = vi.mocked(renameSync).mock.calls.map(([src, dst]) => [String(src), String(dst)])
    const promoted = renameCalls.find(([, dst]) => dst.endsWith('ios-diagnostic-logs.jsonl.1'))
    expect(promoted).toBeDefined()
    expect(promoted![0]).toMatch(/ios-diagnostic-logs\.jsonl$/)
  })

  it('shifts .1→.2 before renaming live to .1', async () => {
    ;(statSync as ReturnType<typeof vi.fn>).mockReturnValue({ size: IOS_LOG_MAX_BYTES + 1 })
    const { handleDiagnosticLogsResponse } = await import('../diagnostics')
    handleDiagnosticLogsResponse(
      { type: 'desktop_diagnostic_logs_response', logs: iosLine(1, 'shift') + '\n', pairingId: 'dev-shift', nextSeq: 2 },
      'dev-shift',
    )
    const renameCalls = vi.mocked(renameSync).mock.calls.map(([src, dst]) => [String(src), String(dst)])
    const shiftIdx = renameCalls.findIndex(([src, dst]) => src.endsWith('.1') && dst.endsWith('.2'))
    const promoteIdx = renameCalls.findIndex(([src, dst]) => src.match(/ios-diagnostic-logs\.jsonl$/) && dst.endsWith('.1'))
    expect(shiftIdx).toBeGreaterThanOrEqual(0)
    expect(promoteIdx).toBeGreaterThan(shiftIdx)
  })

  it('unlinks the oldest generation (.2) before shifting', async () => {
    ;(statSync as ReturnType<typeof vi.fn>).mockReturnValue({ size: IOS_LOG_MAX_BYTES + 1 })
    const { handleDiagnosticLogsResponse } = await import('../diagnostics')
    handleDiagnosticLogsResponse(
      { type: 'desktop_diagnostic_logs_response', logs: iosLine(1, 'prune') + '\n', pairingId: 'dev-prune', nextSeq: 2 },
      'dev-prune',
    )
    const unlinkPaths = vi.mocked(unlinkSync).mock.calls.map(([p]) => String(p))
    expect(unlinkPaths.some((p) => p.endsWith('ios-diagnostic-logs.jsonl.2'))).toBe(true)
  })
})
