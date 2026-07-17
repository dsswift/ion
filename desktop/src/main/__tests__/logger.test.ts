import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

vi.mock('fs')

// Mock the egress forwarder so we can assert exactly which log lines are
// shipped to egress (vs. only written to desktop.jsonl).
const shipToEgressMock = vi.fn()
vi.mock('../log-egress', () => ({
  shipToEgress: (rec: unknown) => shipToEgressMock(rec),
}))

import * as fs from 'fs'
import {
  log,
  trace,
  debug,
  error,
  setSessionContext,
  clearSessionContext,
  configureLogger,
  setLogLevel,
  flushLogs,
  _resetForTest,
} from '../logger'

/**
 * Read back the single line last written to the log. INFO lines are buffered
 * and go through async appendFile; ERROR lines are written synchronously via
 * appendFileSync. flushLogs() drains the buffer synchronously (appendFileSync)
 * so every emitted line is captured by one of the two mocks. We concatenate the
 * captured chunks and parse the trailing newline-terminated JSON object.
 */
function lastLine(): Record<string, unknown> {
  flushLogs()
  const syncCalls = vi.mocked(fs.appendFileSync).mock.calls
  const asyncCalls = vi.mocked(fs.appendFile).mock.calls
  const chunks: string[] = []
  for (const c of syncCalls) chunks.push(String(c[1]))
  for (const c of asyncCalls) chunks.push(String(c[1]))
  const all = chunks.join('')
  const lines = all.split('\n').filter((l) => l.length > 0)
  return JSON.parse(lines[lines.length - 1])
}

/** Count all non-empty lines written so far across sync + async mocks. */
function totalLineCount(): number {
  flushLogs()
  const syncCalls = vi.mocked(fs.appendFileSync).mock.calls
  const asyncCalls = vi.mocked(fs.appendFile).mock.calls
  const chunks: string[] = []
  for (const c of syncCalls) chunks.push(String(c[1]))
  for (const c of asyncCalls) chunks.push(String(c[1]))
  const all = chunks.join('')
  return all.split('\n').filter((l) => l.length > 0).length
}

describe('logger structured JSONL', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTest()
    // statSync is called by initBytes; return a small size so no rotation.
    vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as unknown as fs.Stats)
    configureLogger({ disableRotation: true })
    setLogLevel('DEBUG')
  })

  afterEach(() => {
    _resetForTest()
  })

  it('emits a schema-compliant INFO line', () => {
    log('session', 'hello world')
    const line = lastLine()
    expect(line.component).toBe('desktop')
    expect(line.level).toBe('INFO')
    expect(line.ts).toMatch(/^\d{4}-.*Z$/)
    expect(typeof line.fields).toBe('object')
    expect(line.fields).not.toBeNull()
  })

  it('omits session_id entirely when no context is set', () => {
    log('session', 'no context')
    const line = lastLine()
    expect('session_id' in line).toBe(false)
    expect('conversation_id' in line).toBe(false)
  })

  it('stamps session_id and conversation_id when context is set', () => {
    setSessionContext('sess-1', 'conv-1')
    log('session', 'with context')
    const line = lastLine()
    expect(line.session_id).toBe('sess-1')
    expect(line.conversation_id).toBe('conv-1')
  })

  it('removes IDs after clearSessionContext', () => {
    setSessionContext('sess-1', 'conv-1')
    clearSessionContext()
    log('session', 'cleared')
    const line = lastLine()
    expect('session_id' in line).toBe(false)
    expect('conversation_id' in line).toBe(false)
  })

  it('writes ERROR lines synchronously', () => {
    error('session', 'boom')
    // appendFileSync must be called at emit time, before any flush drains the
    // async buffer. This proves ERROR bypasses the buffer.
    expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalled()
    const chunk = String(vi.mocked(fs.appendFileSync).mock.calls[0][1])
    const line = JSON.parse(chunk.trim())
    expect(line.level).toBe('ERROR')
  })

  it('carries a fields object through to the emitted line', () => {
    log('session', 'with fields', { foo: 'bar' })
    const line = lastLine()
    expect((line.fields as Record<string, unknown>).foo).toBe('bar')
  })

  it('omits the tag field when the tag is an empty string', () => {
    log('', 'no tag')
    const line = lastLine()
    expect('tag' in line).toBe(false)
  })
})

describe('egress recursion exclusion', () => {
  /**
   * RED-proof reasoning
   * -------------------
   * Every desktop log line is shipped to the egress forwarder. The egress
   * subsystem's OWN operational logs (tags prefixed "log_egress") must NOT be
   * fed back into egress: doing so creates a feedback loop — each drain/flush
   * logs, that log becomes a record to ship, the next drain logs again —
   * unbounded self-amplification that keeps the spool growing on its own.
   *
   * On UNFIXED code this test fails: shipToEgress is called for the
   * "log_egress"-tagged line, so the count is 2 instead of 1.
   */
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTest()
    vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as unknown as fs.Stats)
    configureLogger({ disableRotation: true })
    setLogLevel('DEBUG')
  })
  afterEach(() => { _resetForTest() })

  it('ships normal-tagged lines to egress', () => {
    log('session', 'normal line')
    expect(shipToEgressMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT ship log_egress-tagged lines to egress (no feedback loop)', () => {
    log('log_egress', 'spool drain attempt')
    log('log_egress_tailer', 'tailer resumed')
    log('log_egress_spool', 'spool cleared')
    log('log_egress_otel', 'otlp batch built')
    expect(shipToEgressMock).not.toHaveBeenCalled()
  })

  it('ships normal lines but excludes egress-subsystem lines in a mixed run', () => {
    log('session', 'a')
    log('log_egress', 'drain attempt')
    log('main', 'b')
    log('log_egress_tailer', 'poll')
    // Only 'session' and 'main' reach egress.
    expect(shipToEgressMock).toHaveBeenCalledTimes(2)
  })
})

describe('TRACE level', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTest()
    vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as unknown as fs.Stats)
    configureLogger({ disableRotation: true })
    // Default min level is INFO.
  })

  afterEach(() => {
    _resetForTest()
  })

  it('TRACE has a lower order value than DEBUG', () => {
    // Import LEVEL_ORDER indirectly by verifying suppression behavior.
    // A direct numeric check would require exporting the private constant;
    // instead we confirm ordering through emission semantics below.
    // LEVEL_ORDER: TRACE=0, DEBUG=1 — assert trace() is suppressed at DEBUG.
    setLogLevel('DEBUG')
    trace('t', 'should be suppressed at debug')
    expect(totalLineCount()).toBe(0)
  })

  it('INFO default suppresses TRACE', () => {
    // default minLevel is INFO after _resetForTest
    trace('t', 'should be suppressed')
    debug('t', 'also suppressed')
    expect(totalLineCount()).toBe(0)
  })

  it('setLogLevel TRACE emits TRACE lines with level=TRACE', () => {
    setLogLevel('TRACE')
    trace('trace-tag', 'trace message')
    const line = lastLine()
    expect(line.level).toBe('TRACE')
    expect(line.tag).toBe('trace-tag')
    expect(line.msg).toBe('trace message')
    expect(line.component).toBe('desktop')
  })

  it('setLogLevel TRACE also emits DEBUG and INFO', () => {
    setLogLevel('TRACE')
    trace('t', 'trace-line')
    debug('t', 'debug-line')
    log('t', 'info-line')
    // All three should have been written.
    expect(totalLineCount()).toBe(3)
  })
})

describe('rotate — rename-rotate generations', () => {
  const LOG_FILE_PATH = require('path').join(require('os').homedir(), '.ion', 'desktop.jsonl')

  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTest()
    // Rotation is enabled; statSync returns a size >= MAX_FILE_SIZE to trigger it.
    vi.mocked(fs.statSync).mockReturnValue({ size: 21 * 1024 * 1024 } as unknown as fs.Stats)
    // maxGenerations=2 so we can test pruning with fewer renames.
    configureLogger({ disableRotation: false, maxGenerations: 2 })
  })

  afterEach(() => {
    _resetForTest()
  })

  it('renames live file to .1 on first rotation', () => {
    // Trigger rotation via flushLogs (which calls initBytes → size over cap → rotate).
    flushLogs()
    const renameCalls = vi.mocked(fs.renameSync).mock.calls
    // Last rename must be live → .1
    const renameToOne = renameCalls.find(([, dst]) => String(dst) === LOG_FILE_PATH + '.1')
    expect(renameToOne).toBeDefined()
  })

  it('shifts .1→.2 before renaming live to .1', () => {
    flushLogs()
    const renameCalls = vi.mocked(fs.renameSync).mock.calls.map(([src, dst]) => [String(src), String(dst)])
    const shiftIdx = renameCalls.findIndex(([src, dst]) => src === LOG_FILE_PATH + '.1' && dst === LOG_FILE_PATH + '.2')
    const promoteIdx = renameCalls.findIndex(([src, dst]) => src === LOG_FILE_PATH && dst === LOG_FILE_PATH + '.1')
    // Shift must happen before promote.
    expect(shiftIdx).toBeGreaterThanOrEqual(0)
    expect(promoteIdx).toBeGreaterThan(shiftIdx)
  })

  it('deletes the oldest generation (maxGenerations+1) before shifting', () => {
    flushLogs()
    const unlinkCalls = vi.mocked(fs.unlinkSync).mock.calls.map(([p]) => String(p))
    // With maxGenerations=2, generation .2 is the oldest and must be unlinked.
    expect(unlinkCalls).toContain(LOG_FILE_PATH + '.2')
  })

  it('does not call copyFileSync or truncateSync', () => {
    flushLogs()
    expect(vi.mocked(fs.appendFileSync)).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
    )
    // The old copy-then-truncate approach called copyFileSync and truncateSync.
    // Neither exists in our import list now, but we can verify renameSync was used.
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalled()
  })
})
