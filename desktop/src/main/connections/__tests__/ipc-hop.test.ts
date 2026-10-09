/**
 * The IPC hop: the renderer's round trip for one `studio_action` minus
 * main's wire time for the same frame id, paired whichever half lands
 * first, reported as `ipc_hop_p50_ms` on the client window line and reset
 * per window.
 */
import { describe, expect, it, vi } from 'vitest'

const logged = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn() }))
vi.mock('../../logger', () => ({ log: logged.log, warn: logged.warn, debug: logged.debug, error: vi.fn() }))

import { IPC_HOP_FIELD, IpcHopMeter } from '../ipc-hop'
import { Broker } from '../broker'

describe('IpcHopMeter', () => {
  it('pairs main and renderer halves in either order and reports the p50 difference', () => {
    const meter = new IpcHopMeter()
    meter.noteSent('env', 'a', 1_000)
    meter.noteMainResult('env', 'a', 1_040)       // main 40ms
    meter.noteRendererResult('env', 'a', 52)      // hop 12
    meter.noteRendererResult('env', 'b', 70)      // renderer first
    meter.noteSent('env', 'b', 2_000)
    meter.noteMainResult('env', 'b', 2_050)       // main 50 → hop 20
    expect(meter.samples('env')).toBe(2)
    expect(meter.p50('env')).toBe(12)
    expect(meter.p50('other')).toBeNull()
  })

  it('ignores a result for an action it never saw sent, and never reports a negative hop', () => {
    const meter = new IpcHopMeter()
    meter.noteMainResult('env', 'ghost', 5)
    expect(meter.samples('env')).toBe(0)
    meter.noteSent('env', 'x', 0)
    meter.noteMainResult('env', 'x', 100)
    meter.noteRendererResult('env', 'x', 90)
    expect(meter.p50('env')).toBe(0)
  })

  it('decorates a client window line with the hop and starts a fresh window', () => {
    const meter = new IpcHopMeter()
    expect(meter.decorate({ environment_id: 'env', actions: 1 })).toEqual({ environment_id: 'env', actions: 1 })
    meter.noteSent('env', 'a', 0); meter.noteMainResult('env', 'a', 10); meter.noteRendererResult('env', 'a', 15)
    expect(meter.decorate({ environment_id: 'env' })).toEqual({ environment_id: 'env', [IPC_HOP_FIELD]: 5 })
    expect(meter.p50('env')).toBeNull()
  })

  it('drops a send that never got a result once it is older than a minute', () => {
    const meter = new IpcHopMeter()
    meter.noteSent('env', 'lost', 0)
    meter.noteSent('env', 'recent', 30_000)
    expect(meter.pendingSends()).toBe(2)
    meter.noteSent('env', 'next', 61_000)
    expect(meter.pendingSends()).toBe(2)
    meter.noteMainResult('env', 'lost', 61_500)
    expect(meter.samples('env')).toBe(0)
  })
})

describe('Broker client window', () => {
  it('writes ipc_hop_p50_ms beside the wire figures', () => {
    const broker = new Broker()
    broker.send('env', { type: 'studio_action', id: 'a1', action: 'x', args: [] })
    broker.ipcHop.noteMainResult('env', 'a1', Date.now() + 1)
    broker.latency.noteActionResult('env', 'a1')
    broker.ipcHop.noteRendererResult('env', 'a1', 1_000)
    broker.latency.flush()
    const line = logged.log.mock.calls.find((c) => c[0] === 'wire-latency')
    expect(line?.[2]).toMatchObject({ environment_id: 'env', actions: 1 })
    expect(typeof line?.[2][IPC_HOP_FIELD]).toBe('number')
    broker.disconnectAll()
  })
})
