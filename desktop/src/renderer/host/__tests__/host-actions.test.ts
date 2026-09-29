/**
 * host-actions: `host.action` sends a `studio_action` frame and resolves with
 * the correlated `studio_action_result` (spec 12 §Technical Approach Phase 3).
 */
import { describe, it, expect, vi } from 'vitest'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import type { StudioHost } from '../StudioHost'
import { createHostAction, traceparentFromArgs } from '../host-actions'

vi.mock('../../rendererLogger', () => ({ rWarn: vi.fn() }))

/** A minimal fake StudioHost: `send` echoes a scripted reply through `onFrame`. */
function makeFakeHost(reply: (frame: StudioFrame) => StudioFrame | null) {
  const listeners = new Set<(environmentId: string, frame: StudioFrame) => void>()
  const host: Pick<StudioHost, 'send' | 'onFrame'> = {
    send: (environmentId, frame) => {
      const response = reply(frame)
      if (response) {
        for (const cb of listeners) cb(environmentId, response)
      }
    },
    onFrame: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
  return host as StudioHost
}

describe('createHostAction', () => {
  it('resolves with the result value on ok:true', async () => {
    const host = makeFakeHost((frame) => {
      if (frame.type !== 'studio_action') return null
      return { type: 'studio_action_result', id: frame.id, ok: true, value: { count: 3 } }
    })
    const action = createHostAction(host)
    await expect(action('env-1', 'toggleExpanded', [])).resolves.toEqual({ count: 3 })
  })

  it('rejects with the refusal message on ok:false', async () => {
    const host = makeFakeHost((frame) => {
      if (frame.type !== 'studio_action') return null
      return { type: 'studio_action_result', id: frame.id, ok: false, refusal: { message: 'not permitted', code: 'refused' } }
    })
    const action = createHostAction(host)
    await expect(action('env-1', 'dangerousThing', [])).rejects.toThrow('not permitted')
  })

  it('ignores a result meant for a different environment or a different id', async () => {
    const listeners: Array<(environmentId: string, frame: StudioFrame) => void> = []
    const host: Pick<StudioHost, 'send' | 'onFrame'> = {
      send: (environmentId, frame) => {
        if (frame.type !== 'studio_action') return
        // Wrong environment, then wrong id, then the real answer.
        for (const cb of listeners) cb('env-other', { type: 'studio_action_result', id: frame.id, ok: true, value: 'nope' })
        for (const cb of listeners) cb(environmentId, { type: 'studio_action_result', id: 'wrong-id', ok: true, value: 'nope' })
        for (const cb of listeners) cb(environmentId, { type: 'studio_action_result', id: frame.id, ok: true, value: 'yes' })
      },
      onFrame: (cb) => {
        listeners.push(cb)
        return () => {
          const i = listeners.indexOf(cb)
          if (i >= 0) listeners.splice(i, 1)
        }
      },
    }
    const action = createHostAction(host as StudioHost)
    await expect(action('env-1', 'foo', [])).resolves.toBe('yes')
  })

  it('times out when no result ever arrives', async () => {
    vi.useFakeTimers()
    try {
      const host = makeFakeHost(() => null)
      const action = createHostAction(host)
      const promise = action('env-1', 'neverAnswers', [])
      const assertion = expect(promise).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(30_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('traceparent on action frames', () => {
  it('lifts a traceparent from an argument onto the frame', async () => {
    const sent: StudioFrame[] = []
    const host = makeFakeHost((frame) => {
      sent.push(frame)
      return frame.type === 'studio_action' ? { type: 'studio_action_result', id: frame.id, ok: true } : null
    })
    await createHostAction(host)('env-1', 'submit', ['tab-1', 'hi', { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }])
    expect(sent[0]).toMatchObject({ type: 'studio_action', traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' })
  })

  it('leaves the frame alone when no argument carries one', () => {
    expect(traceparentFromArgs(['tab-1', 'hi', { other: 1 }, null])).toBeUndefined()
    expect(traceparentFromArgs([{ traceparent: '' }])).toBeUndefined()
  })
})
