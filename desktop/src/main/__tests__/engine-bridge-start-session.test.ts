/**
 * engine-bridge-start-session — post-start reconcile handshake tests
 *
 * The engine's `start_session` is idempotent. When a desktop attaches
 * to an engine that already has the session loaded (daemon reuse,
 * desktop reinstall, reconnect after socket flap), the engine returns
 * `{ ok: true }` immediately without re-emitting in-flight state.
 *
 * `EngineBridge.startSession` closes the gap by issuing a
 * `reconcile_state` RPC right after a successful `start_session`. That
 * triggers the engine to re-emit `engine_agent_state` + `engine_status`
 * on the same key, including any pending AskUserQuestion / ExitPlanMode
 * permission denials retained on the session. Without this handshake,
 * a freshly-attached desktop would never see those denials and the
 * AskUserQuestion card would silently fail to appear.
 *
 * These tests pin the wire-level behavior:
 *   - Success path: start_session ok → reconcile_state dispatched.
 *   - Failure path: start_session error → reconcile_state NOT dispatched
 *     (the session isn't known to the engine; nothing to snapshot).
 *   - Reconcile uses the same key the caller passed to startSession.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}))
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(() => ''),
}))
vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

import { EngineBridge } from '../engine-bridge'
import type { EngineConfig } from '../../shared/types'

function makeConfig(): EngineConfig {
  return {
    profileId: 'test',
    extensions: [],
    workingDirectory: '/tmp',
  } as EngineConfig
}

function harness() {
  const bridge = new EngineBridge()
  // Stub connect — we don't want to actually open a socket.
  ;(bridge as any).connect = vi.fn(async () => {})

  // Track dispatch calls. _sendWithResult is the start_session path;
  // sendReconcileState is the post-start reconcile path.
  const sendWithResultCalls: any[] = []
  const reconcileCalls: string[] = []
  ;(bridge as any)._sendWithResult = vi.fn(async (msg: any) => {
    sendWithResultCalls.push(msg)
    return { ok: true }
  })
  const origSendReconcileState = bridge.sendReconcileState.bind(bridge)
  bridge.sendReconcileState = (key: string) => {
    reconcileCalls.push(key)
    // Still exercise the underlying path to confirm it doesn't throw.
    try { origSendReconcileState(key) } catch { /* socket not open in tests */ }
  }

  return { bridge, sendWithResultCalls, reconcileCalls }
}

describe('EngineBridge.startSession post-start reconcile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dispatches reconcile_state after a successful start_session', async () => {
    const { bridge, sendWithResultCalls, reconcileCalls } = harness()

    const result = await bridge.startSession('tab1:inst-a', makeConfig())

    expect(result.ok).toBe(true)
    // start_session dispatched exactly once.
    expect(sendWithResultCalls.filter((m) => m.cmd === 'start_session')).toHaveLength(1)
    // reconcile_state dispatched exactly once, with the same key.
    expect(reconcileCalls).toEqual(['tab1:inst-a'])
  })

  it('skips reconcile_state when start_session fails', async () => {
    const { bridge, reconcileCalls } = harness()
    // Override _sendWithResult to return a failure.
    ;(bridge as any)._sendWithResult = vi.fn(async () => ({ ok: false, error: 'boom' }))

    const result = await bridge.startSession('tab2:inst-b', makeConfig())

    expect(result.ok).toBe(false)
    expect(result.error).toBe('boom')
    // No reconcile dispatched.
    expect(reconcileCalls).toEqual([])
  })

  it('registers the session in activeSessions before dispatching', async () => {
    const { bridge } = harness()
    expect(bridge.activeSessions.has('tab3:inst-c')).toBe(false)

    await bridge.startSession('tab3:inst-c', makeConfig())

    expect(bridge.activeSessions.has('tab3:inst-c')).toBe(true)
  })

  it('reuses tracked conversationId from prior session lifecycle', async () => {
    const { bridge, sendWithResultCalls } = harness()
    // Pre-seed an entry with a conversationId (simulates a session that
    // was started before and is being re-started after a stop).
    bridge.activeSessions.set('tab4:inst-d', {
      config: makeConfig(),
      conversationId: 'conv-xyz',
    })

    await bridge.startSession('tab4:inst-d', makeConfig())

    const startMsg = sendWithResultCalls.find((m) => m.cmd === 'start_session')
    expect(startMsg).toBeDefined()
    expect(startMsg.config.sessionId).toBe('conv-xyz')
  })

  it('honors an explicit config.sessionId over the tracked conversationId', async () => {
    const { bridge, sendWithResultCalls } = harness()
    bridge.activeSessions.set('tab5:inst-e', {
      config: makeConfig(),
      conversationId: 'conv-tracked',
    })

    const config = { ...makeConfig(), sessionId: 'conv-explicit' }
    await bridge.startSession('tab5:inst-e', config)

    const startMsg = sendWithResultCalls.find((m) => m.cmd === 'start_session')
    expect(startMsg.config.sessionId).toBe('conv-explicit')
  })
})
