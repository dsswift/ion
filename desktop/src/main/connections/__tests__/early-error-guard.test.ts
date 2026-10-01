/**
 * `EnvironmentConnection.attempt()` attaches its `once('error', ...)` to a
 * freshly opened socket only after an async `open()` resolves. A socket that
 * fails before that listener is attached would otherwise emit 'error' with
 * nothing listening, which Node's EventEmitter throws as an uncaught
 * exception -- this is what crashed the desktop main process with
 * `ECONNRESET` while reconnecting a fleet of environments.
 */
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { guardEarlyError } from '../early-error-guard'

describe('guardEarlyError', () => {
  it('does not throw when the socket errors before anything is listening', () => {
    const emitter = guardEarlyError(new EventEmitter(), 'peer')
    expect(() => emitter.emit('error', new Error('read ECONNRESET'))).not.toThrow()
  })

  it('replays a buffered early error to the next once("error", ...) listener', async () => {
    const emitter = guardEarlyError(new EventEmitter(), 'peer')
    emitter.emit('error', new Error('read ECONNRESET'))
    const received = await new Promise<Error>((resolve) => emitter.once('error', resolve))
    expect(received.message).toBe('read ECONNRESET')
  })

  it('delivers a normal, already-listened-for error straight through, exactly once', () => {
    const emitter = guardEarlyError(new EventEmitter(), 'peer')
    const listener = vi.fn()
    emitter.once('error', listener)
    emitter.emit('error', new Error('boom'))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(new Error('boom'))
  })
})
