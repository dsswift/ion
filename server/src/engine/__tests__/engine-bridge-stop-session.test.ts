/**
 * `stopSession` resolves only once the engine has answered. The engine runs a
 * session's stop on that session's lane and `delete_stored_conversations` on
 * another, so a caller that deletes right after a stop that returned early
 * raced the stop and the engine refused the delete as "is active".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineBridge } from '../engine-bridge'
import { pendingOutboundFor } from '../engine-bridge-core'

function queuedStop(bridge: EngineBridge): { cmd: string; key: string; requestId: string } {
  const line = pendingOutboundFor(bridge).at(-1)
  if (!line) throw new Error('no queued command')
  return JSON.parse(line) as { cmd: string; key: string; requestId: string }
}

async function settled(promise: Promise<void>): Promise<'resolved' | 'rejected' | 'pending'> {
  let state: 'resolved' | 'rejected' | 'pending' = 'pending'
  promise.then(() => { state = 'resolved' }, () => { state = 'rejected' })
  await Promise.resolve()
  await Promise.resolve()
  return state
}

describe('engine bridge stopSession', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('stays pending until the engine answers, then resolves', async () => {
    const bridge = new EngineBridge()
    const stop = bridge.stopSession('tab-a')
    const sent = queuedStop(bridge)
    expect(sent).toMatchObject({ cmd: 'stop_session', key: 'tab-a' })

    expect(await settled(stop)).toBe('pending')

    bridge._handleMessage(JSON.stringify({ cmd: 'result', requestId: sent.requestId, ok: true }))
    expect(await settled(stop)).toBe('resolved')
  })

  it('resolves when the engine answers that it held no session', async () => {
    const bridge = new EngineBridge()
    const stop = bridge.stopSession('never-prompted')
    const sent = queuedStop(bridge)

    bridge._handleMessage(JSON.stringify({ cmd: 'result', requestId: sent.requestId, ok: false, error: 'session "never-prompted" not found' }))
    expect(await settled(stop)).toBe('resolved')
  })

  it('rejects when the engine never answers', async () => {
    const bridge = new EngineBridge()
    const stop = bridge.stopSession('tab-b')
    queuedStop(bridge)

    bridge._failPendingRequests('Connection closed')
    await expect(stop).rejects.toThrow(/did not answer stop_session for tab-b/)
  })

  it('rejects when the request times out', async () => {
    const bridge = new EngineBridge()
    const stop = bridge.stopSession('tab-c')
    const outcome = expect(stop).rejects.toThrow(/Request timed out/)

    await vi.advanceTimersByTimeAsync(30_000)
    await outcome
  })
})
