/**
 * Tests for `handleResetEngineSession` — the engine-instance counterpart
 * to `reset_tab_session`.
 *
 * What this file covers
 * ─────────────────────
 *   1. `bridge.stopSession` is called with the bare tabId.
 *      This is the load-bearing
 *      contract; the whole reason this handler exists is that
 *      `reset_tab_session` routes through bare tabId and silently misses
 *      engine instances.
 *   2. The store's `resetEngineInstance` action is invoked in-process with
 *      tabId and instanceId — this handler runs in the same process as the
 *      store now, so there is no renderer round trip / string injection to
 *      escape (see `store/sessionStore.ts`'s `resetEngineInstance` action).
 *   3. If the store wipe throws, the desktop-side stopSession still
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

const mocks = vi.hoisted(() => ({
  stopSessionMock: vi.fn().mockResolvedValue(undefined),
  resetEngineInstanceMock: vi.fn(),
}))

vi.mock('../../../state', () => {
  const mockEngineBridge = {
    stopSession: (...args: any[]) => mocks.stopSessionMock(...args),
  }
  return {
    state: {
      remoteTransport: { send: vi.fn() },
    },
    engineBridge: mockEngineBridge,
  }
})

vi.mock('../../../store/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      resetEngineInstance: (...args: any[]) => mocks.resetEngineInstanceMock(...args),
    }),
  },
}))

vi.mock('../../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../../attachment-encoder', () => ({
  encodeAttachments: (text: string) => ({ encoded: [], rewrittenText: text }),
}))

vi.mock('../../../prompt-pipeline', () => ({
  processIncomingPrompt: vi.fn().mockResolvedValue(undefined),
}))

import { handleResetEngineSession } from '../engine'

beforeEach(() => {
  mocks.stopSessionMock.mockReset().mockResolvedValue(undefined)
  mocks.resetEngineInstanceMock.mockReset()
})

describe('handleResetEngineSession', () => {
  it('calls bridge.stopSession with the bare tabId (Phase 4b)', async () => {
    await handleResetEngineSession({
      type: 'desktop_reset_engine_session',
      tabId: 'tab-abc',
      instanceId: 'inst-xyz',
    })

    expect(mocks.stopSessionMock).toHaveBeenCalledTimes(1)
    expect(mocks.stopSessionMock).toHaveBeenCalledWith('tab-abc')
  })

  it('invokes the store resetEngineInstance action with tabId and instanceId', async () => {
    await handleResetEngineSession({
      type: 'desktop_reset_engine_session',
      tabId: 'tab-abc',
      instanceId: 'inst-xyz',
    })

    expect(mocks.resetEngineInstanceMock).toHaveBeenCalledTimes(1)
    expect(mocks.resetEngineInstanceMock).toHaveBeenCalledWith('tab-abc', 'inst-xyz')
  })

  it('passes tab/instance ids through unmodified (in-process call, no string injection to escape)', async () => {
    // Since the handler now calls the store action directly rather than
    // interpolating ids into an executeJavaScript string, there is no
    // escaping step — the ids simply pass through as JS values.
    await handleResetEngineSession({
      type: 'desktop_reset_engine_session',
      tabId: "tab'x",
      instanceId: 'inst\\y',
    })

    expect(mocks.resetEngineInstanceMock).toHaveBeenCalledTimes(1)
    expect(mocks.resetEngineInstanceMock).toHaveBeenCalledWith("tab'x", 'inst\\y')
  })

  it('still tears down the engine session even when the store wipe fails', async () => {
    // Order matters: stopSession must run before the store wipe call. If the
    // store action throws, the bridge is already in the right state. The
    // handler catches the error so the iOS caller does not see a failure for
    // what is purely a store-state-cleanup issue.
    mocks.resetEngineInstanceMock.mockImplementationOnce(() => {
      throw new Error('renderer dead')
    })

    await handleResetEngineSession({
      type: 'desktop_reset_engine_session',
      tabId: 'tab-abc',
      instanceId: 'inst-xyz',
    })

    expect(mocks.stopSessionMock).toHaveBeenCalledWith('tab-abc')
    expect(mocks.resetEngineInstanceMock).toHaveBeenCalledTimes(1)
    // The handler did not rethrow.
  })
})
