/**
 * An action's traceparent reaches a socket that can carry it beside the
 * frame (a relay envelope); a plain socket gets the frame alone.
 */
import { describe, it, expect, vi } from 'vitest'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { sendFrame } from '../send-frame'
import type { StudioSocketLike } from '../sealed-studio-socket'

const action: StudioFrame = { type: 'studio_action', id: 'a1', action: 'submit', args: [], traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }

function socket(withTraced: boolean) {
  const send = vi.fn()
  const sendTraced = vi.fn()
  const ws = { send, ...(withTraced ? { sendTraced } : {}) } as unknown as StudioSocketLike
  return { ws, send, sendTraced }
}

describe('sendFrame', () => {
  it('hands an action\'s traceparent to a socket that carries one', () => {
    const { ws, send, sendTraced } = socket(true)
    sendFrame(ws, action)
    expect(sendTraced).toHaveBeenCalledWith(JSON.stringify(action), '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
    expect(send).not.toHaveBeenCalled()
  })

  it('sends a plain frame to a socket with no envelope', () => {
    const { ws, send } = socket(false)
    sendFrame(ws, action)
    expect(send).toHaveBeenCalledWith(JSON.stringify(action))
  })

  it('sends a frame without a traceparent through send', () => {
    const { ws, send, sendTraced } = socket(true)
    sendFrame(ws, { type: 'studio_action', id: 'a2', action: 'x', args: [] })
    expect(send).toHaveBeenCalled()
    expect(sendTraced).not.toHaveBeenCalled()
  })
})
