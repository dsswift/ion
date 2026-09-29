/**
 * engine-bridge sendSetPlanMode — set_plan_mode command shape tests.
 *
 * Pins the wire shape of the set_plan_mode command the desktop emits,
 * specifically the planFilePath field that restores plan-file continuity
 * across an engine-session replacement (see engine SetPlanMode restore
 * branch). The field is additive and OMITTED when empty so the engine's
 * "no restore" default (its prior behavior) is preserved for clients that
 * do not track a plan path.
 *
 * These tests stub the bridge's private `_send` to capture the raw payload
 * object — the same object that is JSON-serialized onto the NDJSON socket.
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

import { EngineBridge } from '../engine-bridge'

function harness() {
  const bridge = new EngineBridge()
  const sent: Array<Record<string, unknown>> = []
  ;(bridge as any)._send = (payload: Record<string, unknown>) => {
    sent.push(payload)
  }
  return { bridge, sent }
}

describe('EngineBridge.sendSetPlanMode — set_plan_mode command shape', () => {
  let h: ReturnType<typeof harness>

  beforeEach(() => {
    h = harness()
  })

  it('includes planFilePath when supplied', () => {
    h.bridge.sendSetPlanMode('tab-1', true, undefined, 'ui_dropdown', undefined, '/Users/x/.ion/plans/simple-sailing-pine.md')
    expect(h.sent).toHaveLength(1)
    const cmd = h.sent[0]
    expect(cmd.cmd).toBe('set_plan_mode')
    expect(cmd.enabled).toBe(true)
    expect(cmd.planFilePath).toBe('/Users/x/.ion/plans/simple-sailing-pine.md')
  })

  it('omits planFilePath when not supplied (the common case)', () => {
    h.bridge.sendSetPlanMode('tab-1', true, undefined, 'ui_dropdown')
    expect(h.sent).toHaveLength(1)
    const cmd = h.sent[0]
    expect(cmd.cmd).toBe('set_plan_mode')
    expect('planFilePath' in cmd).toBe(false)
  })

  it('omits planFilePath when supplied as an empty string', () => {
    h.bridge.sendSetPlanMode('tab-1', true, undefined, 'ui_dropdown', undefined, '')
    expect(h.sent).toHaveLength(1)
    expect('planFilePath' in h.sent[0]).toBe(false)
  })

  it('still carries the bash allowlist alongside planFilePath', () => {
    h.bridge.sendSetPlanMode('tab-1', true, undefined, 'ui_dropdown', ['gh'], '/p/plan.md')
    const cmd = h.sent[0]
    expect(cmd.planModeAllowedBashCommands).toEqual(['gh'])
    expect(cmd.planFilePath).toBe('/p/plan.md')
  })
})
