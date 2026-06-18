/**
 * Tests for `handleResetEngineSession` — the engine-instance counterpart
 * to `reset_tab_session`.
 *
 * What this file covers
 * ─────────────────────
 *   1. `bridge.stopSession` is called with the compound key
 *      `${tabId}:${instanceId}` (NOT bare tabId). This is the load-bearing
 *      contract; the whole reason this handler exists is that
 *      `reset_tab_session` routes through bare tabId and silently misses
 *      engine instances.
 *   2. The renderer-side `resetEngineInstance` action is invoked via
 *      executeJavaScript with both tabId and instanceId properly escaped.
 *   3. If the renderer wipe fails, the desktop-side stopSession still
 *      runs first (errors during the wipe do not block the engine teardown).
 *
 * Why a sibling file rather than appended to an existing test
 * ───────────────────────────────────────────────────────────
 * `desktop/src/main/remote/handlers/__tests__/` previously only contained
 * `slash-intercept.test.ts`. This is the first engine-handler test under
 * that directory; it follows the same vi.mock pattern used elsewhere in
 * the desktop test suite (see prompt-pipeline-clear-wipe.test.ts for the
 * canonical template).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ───────────────────────────────────────────────────────────────────────────
// Mocks
// ───────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const stopSessionMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(undefined) ?? function () { return Promise.resolve() }
  const executeJsMock = (globalThis as any).vi?.fn?.()?.mockResolvedValue?.(null) ?? function () { return Promise.resolve(null) }
  return { stopSessionMock, executeJsMock }
})

mocks.stopSessionMock = vi.fn().mockResolvedValue(undefined)
mocks.executeJsMock = vi.fn().mockResolvedValue(null)

vi.mock('../../../state', () => {
  const mockEngineBridge = {
    stopSession: (...args: any[]) => mocks.stopSessionMock(...args),
  }
  return {
    state: {
      mainWindow: { webContents: { executeJavaScript: (...args: any[]) => mocks.executeJsMock(...args) } },
      remoteTransport: { send: vi.fn() },
    },
    engineBridge: mockEngineBridge,
  }
})

vi.mock('../../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../../attachment-encoder', () => ({
  encodeImageAttachments: (text: string) => ({ encoded: [], rewrittenText: text }),
}))

vi.mock('../../../prompt-pipeline', () => ({
  processIncomingPrompt: vi.fn().mockResolvedValue(undefined),
}))

import { handleResetEngineSession } from '../engine'

beforeEach(() => {
  mocks.stopSessionMock.mockReset().mockResolvedValue(undefined)
  mocks.executeJsMock.mockReset().mockResolvedValue(null)
})

describe('handleResetEngineSession', () => {
  it('calls bridge.stopSession with the compound key ${tabId}:${instanceId}', async () => {
    await handleResetEngineSession({
      type: 'desktop_reset_engine_session',
      tabId: 'tab-abc',
      instanceId: 'inst-xyz',
    })

    expect(mocks.stopSessionMock).toHaveBeenCalledTimes(1)
    expect(mocks.stopSessionMock).toHaveBeenCalledWith('tab-abc:inst-xyz')
  })

  it('invokes the renderer resetEngineInstance action with tabId and instanceId', async () => {
    await handleResetEngineSession({
      type: 'desktop_reset_engine_session',
      tabId: 'tab-abc',
      instanceId: 'inst-xyz',
    })

    expect(mocks.executeJsMock).toHaveBeenCalledTimes(1)
    const jsBody = mocks.executeJsMock.mock.calls[0][0] as string
    expect(jsBody).toContain("resetEngineInstance('tab-abc', 'inst-xyz')")
  })

  it('escapes single quotes and backslashes in tab/instance ids', async () => {
    // Belt-and-suspenders against script injection via crafted ids. The
    // handler mirrors the escape pattern used by every other engine-instance
    // handler in this file (see handleEngineRemoveInstance).
    await handleResetEngineSession({
      type: 'desktop_reset_engine_session',
      tabId: "tab'x",
      instanceId: "inst\\y",
    })

    expect(mocks.executeJsMock).toHaveBeenCalledTimes(1)
    const jsBody = mocks.executeJsMock.mock.calls[0][0] as string
    // tabId 'tab'x' should become 'tab\\'x' (escaped single quote).
    expect(jsBody).toContain("resetEngineInstance('tab\\'x', 'inst\\\\y')")
  })

  it('still tears down the engine session even when the renderer wipe fails', async () => {
    // Order matters: stopSession must run before the JS eval. If the JS
    // eval throws, the bridge is already in the right state. The handler
    // catches the JS error so the iOS caller does not see a failure for
    // what is purely a renderer-state-cleanup issue.
    mocks.executeJsMock.mockRejectedValueOnce(new Error('renderer dead'))

    await handleResetEngineSession({
      type: 'desktop_reset_engine_session',
      tabId: 'tab-abc',
      instanceId: 'inst-xyz',
    })

    expect(mocks.stopSessionMock).toHaveBeenCalledWith('tab-abc:inst-xyz')
    expect(mocks.executeJsMock).toHaveBeenCalledTimes(1)
    // The handler did not rethrow.
  })
})
