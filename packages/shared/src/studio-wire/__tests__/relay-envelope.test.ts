/**
 * The sealed relay envelope: the frame is opaque to the relay, and the push
 * fields a doorbell carries are the only thing beside it in plaintext.
 */
import { describe, expect, it } from 'vitest'
import { sealRelayFrame, openRelayFrame, isRelayEnvelope } from '../relay-envelope'

const secret = Buffer.alloc(32, 4)
const frame = JSON.stringify({ type: 'studio_event', channel: 'studio:push-doorbell', payload: { tabId: 'tab-1', secretWord: 'plover' } })

describe('sealRelayFrame', () => {
  it('seals a frame with no push fields unless asked', () => {
    const envelope = JSON.parse(sealRelayFrame(frame, secret)) as Record<string, unknown>
    expect(Object.keys(envelope).sort()).toEqual(['ciphertext', 'nonce', 'v'])
    expect(openRelayFrame(JSON.stringify(envelope), secret)?.bytes.toString('utf-8')).toBe(frame)
  })

  it('a doorbell keeps the push fields in plaintext and the frame sealed', () => {
    const text = sealRelayFrame(frame, secret, { pushTitle: 'Approval needed', pushBody: 'Bash wants to run', pushTabId: 'tab-1', notifyKind: 'permission', notifyResourceId: 'res-7' })
    const envelope = JSON.parse(text) as Record<string, unknown>
    // Exactly the names the relay's relayMessage struct reads.
    expect(envelope).toMatchObject({ v: 1, push: true, pushTitle: 'Approval needed', pushBody: 'Bash wants to run', pushTabId: 'tab-1', notifyKind: 'permission', notifyResourceId: 'res-7' })
    expect(text).not.toContain('plover')
    expect(isRelayEnvelope(envelope)).toBe(true)
    expect(openRelayFrame(text, secret)?.bytes.toString('utf-8')).toBe(frame)
  })

  it('leaves an empty or missing push field off, so the relay\'s own defaults apply', () => {
    const envelope = JSON.parse(sealRelayFrame(frame, secret, { pushTitle: '', pushTabId: 'tab-1' })) as Record<string, unknown>
    expect(envelope.push).toBe(true)
    expect(envelope).not.toHaveProperty('pushTitle')
    expect(envelope).not.toHaveProperty('pushBody')
    expect(envelope.pushTabId).toBe('tab-1')
  })

  // The phone sets a traceparent beside the frame that carries a prompt, for
  // the relay's forward span. The receiving server opens it like any other.
  it('opens an envelope that carries a traceparent beside the sealed frame', () => {
    const envelope = { ...(JSON.parse(sealRelayFrame(frame, secret)) as Record<string, unknown>), traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }
    expect(isRelayEnvelope(envelope)).toBe(true)
    expect(openRelayFrame(JSON.stringify(envelope), secret)?.bytes.toString('utf-8')).toBe(frame)
  })

  it('a push field does not unseal a frame for the wrong secret', () => {
    const text = sealRelayFrame(frame, secret, { pushTitle: 'x' })
    expect(openRelayFrame(text, Buffer.alloc(32, 5))).toBeNull()
  })
})

describe('sealRelayFrame traceparent', () => {
  it('puts a traceparent beside the sealed frame and still opens', () => {
    const text = sealRelayFrame(frame, secret, undefined, '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
    const envelope = JSON.parse(text) as Record<string, unknown>
    expect(envelope.traceparent).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
    expect(JSON.stringify(envelope)).not.toContain('plover')
    expect(openRelayFrame(text, secret)?.bytes.toString()).toBe(frame)
  })

  it('omits the field when there is no traceparent', () => {
    expect(JSON.parse(sealRelayFrame(frame, secret)) as Record<string, unknown>).not.toHaveProperty('traceparent')
  })
})
