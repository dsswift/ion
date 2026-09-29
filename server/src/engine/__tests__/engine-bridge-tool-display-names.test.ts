/**
 * The engine's own tools reach a delegated-CLI run as `mcp__ion-extensions__<tool>`.
 * The prefix is stripped where the bridge receives the event, before ANY listener
 * runs. An earlier version stripped it inside one listener and the control plane
 * that feeds the store, registered ahead of it, still saw the prefixed name, so
 * this pins the seam every listener shares.
 */
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { handleMessage } from '../engine-bridge-core'
import type { EngineBridge } from '../engine-bridge'

function fakeBridge(): { bridge: EngineBridge; seen: Array<{ key: string; event: any }> } {
  const emitter = new EventEmitter()
  const seen: Array<{ key: string; event: any }> = []
  // First listener stands in for the control plane, which registers before the
  // event-wiring listener and used to run ahead of the strip.
  emitter.on('event', (key: string, event: unknown) => seen.push({ key, event }))
  const bridge = Object.assign(emitter, {
    consecutiveTimeouts: 0,
    keyAliases: new Map<string, string>(),
    lastEngineStatusAt: new Map<string, number>(),
    requestCallbacks: new Map(),
  }) as unknown as EngineBridge
  return { bridge, seen }
}

const frame = (event: Record<string, unknown>) => JSON.stringify({ key: 'tab-1', event })

describe('handleMessage — tool display names', () => {
  it('hands the first listener the bare tool name', () => {
    const { bridge, seen } = fakeBridge()
    handleMessage(bridge, frame({ type: 'engine_tool_start', toolName: 'mcp__ion-extensions__Bash', toolId: 't1' }))
    expect(seen[0].event.toolName).toBe('Bash')
  })

  it("leaves another MCP server's tool prefixed", () => {
    const { bridge, seen } = fakeBridge()
    handleMessage(bridge, frame({ type: 'engine_tool_start', toolName: 'mcp__github__create_issue', toolId: 't2' }))
    expect(seen[0].event.toolName).toBe('mcp__github__create_issue')
  })
})
