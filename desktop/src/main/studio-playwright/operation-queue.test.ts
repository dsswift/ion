import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { OperationQueues, QueueCancelledError } from './operation-queue'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('operation queues', () => {
  it('runs operations on one instance strictly in order', async () => {
    const queues = new OperationQueues()
    const order: string[] = []
    const first = deferred<void>()

    const a = queues.run('b1', 'click', async () => { await first.promise; order.push('a') })
    const b = queues.run('b1', 'type', async () => { order.push('b') })

    // 'b' must not start while 'a' is in flight: interleaving two actions on
    // one page is how a click lands on a DOM the previous action is rewriting.
    expect(order).toEqual([])
    first.resolve()
    await Promise.all([a, b])
    expect(order).toEqual(['a', 'b'])
  })

  it('keeps different instances parallel', async () => {
    const queues = new OperationQueues()
    const blocked = deferred<void>()
    const order: string[] = []

    const slow = queues.run('b1', 'screenshot', async () => { await blocked.promise; order.push('slow') })
    await queues.run('b2', 'click', async () => { order.push('fast') })

    // A long capture in one conversation must not stall another conversation.
    expect(order).toEqual(['fast'])
    blocked.resolve()
    await slow
    expect(order).toEqual(['fast', 'slow'])
  })

  it('continues after an operation throws', async () => {
    const queues = new OperationQueues()
    const failed = queues.run('b1', 'click', async () => { throw new Error('detached') })
    await expect(failed).rejects.toThrow('detached')
    await expect(queues.run('b1', 'type', async () => 'ok')).resolves.toBe('ok')
  })

  it('fails queued work when the tab closes', async () => {
    const queues = new OperationQueues()
    const blocker = deferred<void>()
    const running = queues.run('b1', 'navigate', async () => { await blocker.promise })
    const queued = queues.run('b1', 'click', async () => 'never')

    queues.cancel('b1', 'the browser tab was closed')

    // Queued work must fail visibly. Leaving it pending would hang the model's
    // turn on a tab that no longer exists.
    await expect(queued).rejects.toBeInstanceOf(QueueCancelledError)
    blocker.resolve()
    await running
  })

  it('starts a fresh queue after a cancel', async () => {
    const queues = new OperationQueues()
    queues.cancel('b1', 'closed')
    await expect(queues.run('b1', 'click', async () => 'reopened')).resolves.toBe('reopened')
  })
})
