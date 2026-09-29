/**
 * emit() used to gate every log write behind `window.ion &&`, a check that
 * predates BrowserStudioHost and is always false in a real browser tab (by
 * design -- window.ion is the Electron-only contextBridge global). That
 * silently dropped every renderer log in the browser client, including
 * RootErrorBoundary's own crash reports, which made diagnosing a live
 * browser-only bug impossible without this fix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { logWrite } = vi.hoisted(() => ({ logWrite: vi.fn() }))
vi.mock('./host/host-instance', () => ({ host: { shell: { logWrite } } }))

import { rError } from './rendererLogger'

beforeEach(() => {
  logWrite.mockClear()
})

describe('rendererLogger emit', () => {
  it('calls host.shell.logWrite without requiring window.ion (browser Studio client)', () => {
    expect((globalThis as { window?: { ion?: unknown } }).window?.ion).toBeUndefined()
    rError('test-tag', 'test message', { key: 'value' })
    expect(logWrite).toHaveBeenCalledWith('ERROR', 'test-tag', 'test message', { key: 'value' })
  })
})
