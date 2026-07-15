/**
 * Tests for the log:write IPC handler (A3 renderer structured-log bridge).
 *
 * Verifies that:
 * - A renderer-supplied fields object is preserved intact (regression pin for
 *   the [object Object] defect that arises when a non-object is passed).
 * - Level routing calls the matching logger emitter.
 * - Malformed / missing fields default to {}.
 * - Unrecognised levels fall back to INFO.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

// ─── Mock the desktop logger before importing the handler ───
vi.mock('../logger', () => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

// ─── Mock Electron's ipcMain so the handler can register without a real process ───
const handleFns = new Map<string, (event: unknown, payload: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, payload: unknown) => unknown) => {
      handleFns.set(channel, fn)
    },
  },
}))

import * as logger from '../logger'
import { registerLogIpc } from '../ipc/log'
import { IPC } from '../../shared/types'

/** Invoke the registered handler directly, mimicking the IPC call from the renderer. */
function invoke(payload: unknown): unknown {
  const fn = handleFns.get(IPC.LOG_WRITE)
  if (!fn) throw new Error('log:write handler not registered')
  return fn({} /* event */, payload)
}

describe('log:write IPC handler', () => {
  beforeEach(() => {
    handleFns.clear()
    vi.clearAllMocks()
    // Register the handler fresh for each test.
    registerLogIpc()
  })

  it('routes TRACE level to logger.trace()', () => {
    invoke({ level: 'TRACE', tag: 'renderer', msg: 'hello', fields: {} })
    expect(logger.trace).toHaveBeenCalledWith('renderer', 'hello', {})
  })

  it('routes DEBUG level to logger.debug()', () => {
    invoke({ level: 'DEBUG', tag: 'r', msg: 'dbg', fields: { x: 1 } })
    expect(logger.debug).toHaveBeenCalledWith('r', 'dbg', { x: 1 })
  })

  it('routes INFO level to logger.info()', () => {
    invoke({ level: 'INFO', tag: 'r', msg: 'inf', fields: {} })
    expect(logger.info).toHaveBeenCalledWith('r', 'inf', {})
  })

  it('routes WARN level to logger.warn()', () => {
    invoke({ level: 'WARN', tag: 'r', msg: 'wrn', fields: {} })
    expect(logger.warn).toHaveBeenCalledWith('r', 'wrn', {})
  })

  it('routes ERROR level to logger.error()', () => {
    invoke({ level: 'ERROR', tag: 'r', msg: 'err', fields: {} })
    expect(logger.error).toHaveBeenCalledWith('r', 'err', {})
  })

  it('preserves a structured fields object — regression pin for [object Object] defect', () => {
    const fields = { tabId: 'abc-123', toolName: 'Read', durationMs: 42 }
    invoke({ level: 'INFO', tag: 'tool', msg: 'tool called', fields })
    expect(logger.info).toHaveBeenCalledWith('tool', 'tool called', fields)
    // Specifically assert the exact object is forwarded, not "[object Object]".
    const passedFields = vi.mocked(logger.info).mock.calls[0][2]
    expect(typeof passedFields).toBe('object')
    expect((passedFields as Record<string, unknown>).tabId).toBe('abc-123')
    expect((passedFields as Record<string, unknown>).durationMs).toBe(42)
  })

  it('defaults fields to {} when fields is undefined', () => {
    invoke({ level: 'INFO', tag: 'r', msg: 'm' })
    expect(logger.info).toHaveBeenCalledWith('r', 'm', {})
  })

  it('defaults fields to {} when fields is a non-object string (defect guard)', () => {
    invoke({ level: 'INFO', tag: 'r', msg: 'm', fields: '[object Object]' })
    expect(logger.info).toHaveBeenCalledWith('r', 'm', {})
  })

  it('defaults fields to {} when fields is an array', () => {
    invoke({ level: 'INFO', tag: 'r', msg: 'm', fields: ['a', 'b'] })
    expect(logger.info).toHaveBeenCalledWith('r', 'm', {})
  })

  it('falls back to INFO for an unrecognised level string', () => {
    invoke({ level: 'VERBOSE', tag: 'r', msg: 'm', fields: {} })
    expect(logger.info).toHaveBeenCalledWith('r', 'm', {})
  })

  it('uses "renderer" as default tag when tag is missing', () => {
    invoke({ level: 'INFO', msg: 'no tag', fields: {} })
    expect(logger.info).toHaveBeenCalledWith('renderer', 'no tag', {})
  })

  it('does nothing when the payload is not an object', () => {
    invoke('bad payload')
    invoke(null)
    invoke(42)
    expect(logger.trace).not.toHaveBeenCalled()
    expect(logger.debug).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })
})
