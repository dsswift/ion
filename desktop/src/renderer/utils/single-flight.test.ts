/**
 * Pins the poll guard: a tick that fires while the previous run is still in
 * flight is dropped (never queued), and the gate reopens after settle — both
 * outcomes. This is the renderer half of the inventory spawn-storm fix.
 */
import { describe, it, expect } from 'vitest'
import { singleFlight } from './single-flight'

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('singleFlight', () => {
  it('drops invocations that arrive while a run is in flight', async () => {
    let runs = 0
    const gate = deferred()
    const tick = singleFlight(() => { runs++; return gate.promise })

    tick()
    tick()
    tick()
    expect(runs).toBe(1)

    gate.resolve()
    await gate.promise
  })

  it('runs again after the previous flight resolves', async () => {
    let runs = 0
    const first = deferred()
    const tick = singleFlight(() => { runs++; return runs === 1 ? first.promise : Promise.resolve() })

    tick()
    first.resolve()
    await first.promise
    tick()
    expect(runs).toBe(2)
  })

  it('reopens the gate after a rejected flight instead of jamming shut', async () => {
    let runs = 0
    const first = deferred()
    const tick = singleFlight(() => { runs++; return runs === 1 ? first.promise : Promise.resolve() })

    tick()
    first.reject(new Error('fetch failed'))
    // Settle the microtask queue so the rejection handler runs.
    await Promise.resolve()
    await Promise.resolve()

    tick()
    expect(runs).toBe(2)
  })
})
