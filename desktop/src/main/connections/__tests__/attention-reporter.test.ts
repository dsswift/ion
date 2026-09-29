/**
 * Every connected Environment hears this desktop's window focus.
 *
 * A server runs its worktree freshness poll only while some connected client
 * is attentive, and attention is recorded per connection. Reported to the
 * local server alone, a visited server never heard it and its worktree rows
 * stayed frozen at whatever they were when something last asked.
 */
import { describe, expect, it, vi } from 'vitest'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import type { Broker } from '../broker'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn() }))

import { wireAttentionReporting } from '../attention-reporter'

function fakeBroker(environmentIds: string[]) {
  const frameListeners: Array<(environmentId: string, frame: StudioFrame) => void> = []
  const sendAction = vi.fn(async (_environmentId: string, _action: string, _args: unknown[]) => undefined)
  const broker = {
    environmentIds: () => environmentIds,
    onFrame: (cb: (environmentId: string, frame: StudioFrame) => void) => { frameListeners.push(cb); return () => {} },
    sendAction,
  }
  const emit = (environmentId: string, frame: StudioFrame): void => { for (const cb of frameListeners) cb(environmentId, frame) }
  return { broker: broker as unknown as Broker, sendAction, emit }
}

describe('wireAttentionReporting', () => {
  it('reports the current focus to every connected Environment when wired', () => {
    const { broker, sendAction } = fakeBroker(['local', 'env-remote'])
    wireAttentionReporting(broker, () => true)
    expect(sendAction.mock.calls).toEqual([
      ['local', 'presence.attention', [true]],
      ['env-remote', 'presence.attention', [true]],
    ])
  })

  it('reports every focus change to every connected Environment', () => {
    const { broker, sendAction } = fakeBroker(['local', 'env-remote'])
    const report = wireAttentionReporting(broker, () => true)
    sendAction.mockClear()
    report(false)
    expect(sendAction.mock.calls).toEqual([
      ['local', 'presence.attention', [false]],
      ['env-remote', 'presence.attention', [false]],
    ])
  })

  // A new connection (first connect, reconnect, server restart) starts with
  // no attention on the server until this desktop says so.
  it('reports the current focus to an Environment the moment it welcomes', () => {
    const { broker, sendAction, emit } = fakeBroker([])
    let focused = false
    wireAttentionReporting(broker, () => focused)
    focused = true
    emit('env-remote', { type: 'studio_welcome' } as StudioFrame)
    emit('env-remote', { type: 'studio_event', channel: 'x', payload: null } as StudioFrame)
    expect(sendAction.mock.calls).toEqual([['env-remote', 'presence.attention', [true]]])
  })
})
