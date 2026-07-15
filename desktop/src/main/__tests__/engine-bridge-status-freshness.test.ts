/**
 * EngineBridge status-freshness tracking — regression test for the #240
 * `desktop_` wire-prefix rename.
 *
 * The snapshot poller detects "stale" session keys (no fresh status seen for
 * STALE_STATUS_THRESHOLD_MS) and re-issues query_session_status for them. The
 * freshness signal comes from `_handleMessage` stamping `lastEngineStatusAt`
 * whenever an INBOUND `engine_status` event arrives.
 *
 * #240 mistakenly renamed that inbound check to `desktop_status` (the OUTBOUND
 * iOS wire type). Because inbound engine events are typed `engine_status`, the
 * stamp never fired: every key read as stale, so the 5 s poll re-queried every
 * session forever — a status-broadcast storm fanned to every paired device.
 *
 * These tests pin the exact contract: `engine_status` stamps freshness; other
 * event types do not. With the old `desktop_status` string, the first
 * assertion goes red.
 */

import { describe, it, expect, vi } from 'vitest'

// Mock filesystem and child_process — imported at module load even though only
// used in connect/start paths, which these tests never exercise.
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

function makeBridge() {
  const bridge = new EngineBridge()
  return bridge
}

function inject(bridge: EngineBridge, key: string, type: string): void {
  const line = JSON.stringify({ key, event: { type, fields: { label: key, state: 'idle' } } })
  ;(bridge as any)['_handleMessage'](line)
}

describe('EngineBridge status-freshness tracking', () => {
  it('stamps lastEngineStatusAt when an inbound engine_status arrives', () => {
    const bridge = makeBridge()
    const freshness: Map<string, number> = (bridge as any)['lastEngineStatusAt']
    expect(freshness.has('S:i1')).toBe(false)

    inject(bridge, 'S:i1', 'engine_status')

    expect(freshness.has('S:i1')).toBe(true)
    expect(typeof freshness.get('S:i1')).toBe('number')
  })

  it('does NOT stamp freshness for non-status inbound events', () => {
    const bridge = makeBridge()
    const freshness: Map<string, number> = (bridge as any)['lastEngineStatusAt']

    inject(bridge, 'S:i2', 'engine_text_delta')
    inject(bridge, 'S:i2', 'engine_tool_start')

    expect(freshness.has('S:i2')).toBe(false)
  })

  it('does NOT stamp freshness for the outbound desktop_status wire type', () => {
    // desktop_status is what THIS desktop emits to iOS; it never arrives inbound
    // over the engine socket. Guard against the #240 regression reappearing.
    const bridge = makeBridge()
    const freshness: Map<string, number> = (bridge as any)['lastEngineStatusAt']

    inject(bridge, 'S:i3', 'desktop_status')

    expect(freshness.has('S:i3')).toBe(false)
  })

  it('stamps freshness under the routed key when the session is aliased', () => {
    const bridge = makeBridge()
    const freshness: Map<string, number> = (bridge as any)['lastEngineStatusAt']
    bridge.remapSession('OLD:i1', 'NEW:i1')

    inject(bridge, 'OLD:i1', 'engine_status')

    // The snapshot poller sweeps activeSessions keys (routed keys), so the
    // stamp must land on the routed key, not the raw inbound key.
    expect(freshness.has('NEW:i1')).toBe(true)
    expect(freshness.has('OLD:i1')).toBe(false)
  })
})
