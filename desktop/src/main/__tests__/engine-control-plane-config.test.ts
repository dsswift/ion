/**
 * engine-control-plane-config — pin the resolveClaudeCompat fallback.
 *
 * resolveClaudeCompat reads the settings file; when that throws (missing,
 * corrupt, permission denied) it must log a warning and return the compiled
 * default rather than propagating the error to the session-start path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../settings-store', () => ({
  readSettings: vi.fn(),
  SETTINGS_DEFAULTS: { enableClaudeCompat: false },
}))

const warnCalls: Array<{ tag: string; msg: string }> = []
vi.mock('../logger', () => ({
  warn: (tag: string, msg: string, _fields?: Record<string, unknown>) => {
    warnCalls.push({ tag, msg })
  },
}))

import { resolveClaudeCompat } from '../engine-control-plane-config'
import { readSettings } from '../settings-store'

const mockReadSettings = vi.mocked(readSettings)

beforeEach(() => {
  warnCalls.length = 0
  mockReadSettings.mockReset()
})

describe('resolveClaudeCompat', () => {
  it('returns the stored value when readSettings succeeds', () => {
    mockReadSettings.mockReturnValue({ enableClaudeCompat: true } as ReturnType<typeof readSettings>)
    expect(resolveClaudeCompat()).toBe(true)
    expect(warnCalls).toHaveLength(0)
  })

  it('returns the compiled default when readSettings returns undefined for the key', () => {
    mockReadSettings.mockReturnValue({} as ReturnType<typeof readSettings>)
    expect(resolveClaudeCompat()).toBe(false)
    expect(warnCalls).toHaveLength(0)
  })

  it('falls back to the compiled default and logs when readSettings throws', () => {
    mockReadSettings.mockImplementation(() => { throw new Error('ENOENT') })
    expect(resolveClaudeCompat()).toBe(false)
    expect(warnCalls).toHaveLength(1)
    expect(warnCalls[0].tag).toBe('control-plane')
    expect(warnCalls[0].msg).toContain('falling back to default')
  })

  it('does not propagate the error', () => {
    mockReadSettings.mockImplementation(() => { throw new Error('corrupted JSON') })
    expect(() => resolveClaudeCompat()).not.toThrow()
  })
})
