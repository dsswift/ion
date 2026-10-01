import { describe, expect, it } from 'vitest'
import {
  PORT_STREAM_WINDOW_BYTES, PortStream, decodePortCredit, encodePortCredit, forwardedUrl, isForwardablePort, loopbackUrlPort,
  type PortStreamOutcome, type PortStreamSocket,
} from '../port-forward'

/** Any listener the stream registers, whatever its argument. */
type Listener = (arg: never) => void

/** A socket the test drives by hand: it emits what a peer would send and records what the stream does to it. */
function fakeSocket() {
  const listeners = new Map<string, Listener[]>()
  const written: Uint8Array[] = []
  const writeCallbacks: Array<(err?: Error | null) => void> = []
  const state = { paused: true, ended: false, destroyed: false }
  const socket: PortStreamSocket = {
    pause: () => { state.paused = true },
    resume: () => { state.paused = false },
    write: (data, cb) => {
      written.push(data)
      if (cb) writeCallbacks.push(cb)
      return true
    },
    end: () => { state.ended = true },
    destroy: () => { state.destroyed = true },
    on: (event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return undefined
    },
  }
  return {
    socket, state, written,
    emit: (event: string, arg?: unknown) => { for (const l of listeners.get(event) ?? []) (l as (arg: unknown) => void)(arg) },
    /** The socket reports every write so far as flushed. */
    flushWrites: () => { for (const cb of writeCallbacks.splice(0)) cb() },
  }
}

function fakeWire() {
  const data: Uint8Array[] = []
  const credits: number[] = []
  const ends: boolean[] = []
  return {
    data, credits, ends,
    wire: {
      data: (payload: Uint8Array) => { data.push(payload); return true },
      credit: (bytes: number) => { credits.push(bytes) },
      end: (aborted: boolean) => { ends.push(aborted) },
    },
  }
}

function harness() {
  const s = fakeSocket()
  const w = fakeWire()
  const outcomes: PortStreamOutcome[] = []
  const stream = new PortStream(s.socket, w.wire, (outcome) => outcomes.push(outcome))
  return { ...s, ...w, stream, outcomes }
}

describe('port credit payload', () => {
  it('round-trips a byte count', () => {
    expect(decodePortCredit(encodePortCredit(65_536))).toBe(65_536)
  })

  it('rejects a payload of the wrong length', () => {
    expect(decodePortCredit(new Uint8Array(3))).toBeNull()
  })
})

describe('forwardable ports and URLs', () => {
  it('accepts only whole TCP port numbers', () => {
    expect(isForwardablePort(5173)).toBe(true)
    expect(isForwardablePort(0)).toBe(false)
    expect(isForwardablePort(65_536)).toBe(false)
    expect(isForwardablePort(80.5)).toBe(false)
    expect(isForwardablePort('5173')).toBe(false)
  })

  it('reads the port of a loopback URL and of no other', () => {
    expect(loopbackUrlPort('http://localhost:5173/app')).toBe(5173)
    expect(loopbackUrlPort('https://localhost')).toBe(443)
    expect(loopbackUrlPort('http://[::1]:8080')).toBe(8080)
    expect(loopbackUrlPort('http://example.org:5173')).toBeNull()
    expect(loopbackUrlPort('file:///tmp/index.html')).toBeNull()
    expect(loopbackUrlPort('not a url')).toBeNull()
  })

  it('points a URL at the local end and keeps its path and query', () => {
    expect(forwardedUrl('http://[::1]:5173/app?x=1#top', { localPort: 61000 })).toBe('http://localhost:61000/app?x=1#top')
    expect(forwardedUrl('https://localhost:7001/', { localPort: 7001 })).toBe('https://localhost:7001/')
  })
})

describe('PortStream', () => {
  it('does not read its socket until started', () => {
    const h = harness()
    expect(h.state.paused).toBe(true)
    h.stream.start()
    expect(h.state.paused).toBe(false)
  })

  it('stops reading when its credit is spent and resumes when more is granted', () => {
    const h = harness()
    h.stream.start()
    h.emit('data', new Uint8Array(PORT_STREAM_WINDOW_BYTES - 1))
    expect(h.state.paused).toBe(false)
    h.emit('data', new Uint8Array(1))
    expect(h.state.paused).toBe(true)
    h.stream.receiveCredit(1024)
    expect(h.state.paused).toBe(false)
    expect(h.data).toHaveLength(2)
  })

  it('holds further reads until an in-flight send has left', async () => {
    const s = fakeSocket()
    let release!: (ok: boolean) => void
    const stream = new PortStream(s.socket, {
      data: () => new Promise<boolean>((resolve) => { release = resolve }),
      credit: () => {},
      end: () => {},
    }, () => {})
    stream.start()
    s.emit('data', new Uint8Array(10))
    expect(s.state.paused).toBe(true)
    // Credit alone does not resume a stream whose last chunk is still on its way out.
    stream.receiveCredit(1024)
    expect(s.state.paused).toBe(true)
    release(true)
    await Promise.resolve()
    expect(s.state.paused).toBe(false)
  })

  it('grants credit back only for bytes its socket has taken', () => {
    const h = harness()
    h.stream.receiveData(new Uint8Array(PORT_STREAM_WINDOW_BYTES / 2))
    expect(h.written).toHaveLength(1)
    expect(h.credits).toEqual([])
    h.flushWrites()
    expect(h.credits).toEqual([PORT_STREAM_WINDOW_BYTES / 2])
  })

  it('completes when both directions have finished, without telling the peer twice', () => {
    const h = harness()
    h.stream.start()
    h.emit('end')
    expect(h.ends).toEqual([false])
    expect(h.outcomes).toEqual([])
    h.stream.receiveEnd(false)
    expect(h.state.ended).toBe(true)
    h.emit('close')
    expect(h.ends).toEqual([false])
    expect(h.outcomes).toEqual([expect.objectContaining({ outcome: 'completed' })])
  })

  it('keeps writing what the other end sends after its own side finished', () => {
    const h = harness()
    h.stream.start()
    h.emit('end')
    h.stream.receiveData(new Uint8Array([1, 2, 3]))
    expect(h.written).toHaveLength(1)
    expect(h.state.destroyed).toBe(false)
  })

  it('tells the peer when its socket dies mid-stream', () => {
    const h = harness()
    h.stream.start()
    h.emit('error', new Error('reset'))
    expect(h.ends).toEqual([true])
    expect(h.state.destroyed).toBe(true)
    expect(h.outcomes).toEqual([expect.objectContaining({ outcome: 'aborted' })])
    // The close that follows an error does not report a second outcome.
    h.emit('close')
    expect(h.outcomes).toHaveLength(1)
  })

  it('destroys its socket without answering when the peer abandons the stream', () => {
    const h = harness()
    h.stream.start()
    h.stream.receiveEnd(true)
    expect(h.state.destroyed).toBe(true)
    expect(h.ends).toEqual([])
  })

  it('ends without a word when the connection can no longer carry it', () => {
    const s = fakeSocket()
    const ends: boolean[] = []
    const outcomes: PortStreamOutcome[] = []
    const stream = new PortStream(s.socket, { data: () => false, credit: () => {}, end: (a) => { ends.push(a) } }, (o) => outcomes.push(o))
    stream.start()
    s.emit('data', new Uint8Array(4))
    expect(s.state.destroyed).toBe(true)
    expect(ends).toEqual([])
    expect(outcomes[0]).toMatchObject({ outcome: 'aborted', bytesSent: 4 })
  })
})
