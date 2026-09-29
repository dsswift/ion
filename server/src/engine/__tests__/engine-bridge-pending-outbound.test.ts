/**
 * Commands sent before the engine socket is connected are held and written
 * in order once it is. Boot restoration sends every saved tab's
 * set_plan_mode while the first connect is still in flight; those were
 * dropped with a warning, so a restored plan-mode tab came back in auto.
 */
import { describe, expect, it } from 'vitest'
import { EngineBridge } from '../engine-bridge'
import { send, pendingOutboundFor } from '../engine-bridge-core'
import { flushPendingOutbound } from '../engine-bridge-connection'

describe('engine bridge pending outbound queue', () => {
  it('queues while disconnected and flushes in order on connect', () => {
    const bridge = new EngineBridge()
    expect(send(bridge, { cmd: 'set_plan_mode', key: 'a', enabled: true })).toBe(true)
    expect(send(bridge, { cmd: 'set_plan_mode', key: 'b', enabled: false })).toBe(true)
    expect(pendingOutboundFor(bridge)).toHaveLength(2)

    const written: string[] = []
    flushPendingOutbound(bridge, { write: (line: string) => written.push(line) } as never)
    expect(written.map((l) => (JSON.parse(l) as { key: string }).key)).toEqual(['a', 'b'])
    expect(pendingOutboundFor(bridge)).toEqual([])
  })

  it('drops rather than queues once the bridge has been stopped', () => {
    const bridge = new EngineBridge()
    bridge.reconnectDisabled = true
    expect(send(bridge, { cmd: 'set_plan_mode', key: 'a' })).toBe(false)
    expect(pendingOutboundFor(bridge)).toEqual([])
  })
})
