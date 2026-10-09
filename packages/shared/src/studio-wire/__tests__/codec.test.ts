import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { decodeBinary, decodeFrame, encodeBinary, encodeFrame, WireError } from '../codec'
import { BinaryChannel } from '../channels'
import type { StudioFrame } from '../types'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'v1')

function loadFixtures(): { name: string; frame: StudioFrame }[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f, frame: JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf-8')) as StudioFrame }))
}

describe('studio-wire codec: fixtures', () => {
  const fixtures = loadFixtures()

  // A type may have more than one fixture (an optional form, such as a paged
  // body, gets its own), but every type has at least one.
  it('has a fixture for every StudioFrame type', () => {
    const expectedTypes = [
      'studio_hello',
      'studio_welcome',
      'studio_refused',
      'studio_action',
      'studio_action_result',
      'studio_event',
      'studio_command',
      'studio_command_result',
      'studio_snapshot',
      'studio_reauth',
      'studio_environment_policy',
      'studio_snapshot_request',
      'studio_body_request',
      'studio_body',
      'studio_close',
    ]
    const presentTypes = [...new Set(fixtures.map((f) => f.frame.type))].sort()
    expect(presentTypes).toEqual([...expectedTypes].sort())
  })

  for (const { name, frame } of loadFixtures()) {
    it(`round-trips ${name} byte-for-byte through decode -> encode -> decode`, () => {
      const text = JSON.stringify(frame)
      const decoded = decodeFrame(text)
      expect(decoded).toEqual(frame)
      const reEncoded = encodeFrame(decoded)
      const reDecoded = decodeFrame(reEncoded)
      expect(reDecoded).toEqual(frame)
    })
  }
})

describe('studio-wire codec: frames from another build', () => {
  const welcome = loadFixtures().find((f) => f.frame.type === 'studio_welcome')?.frame as unknown as Record<string, unknown>

  // A server that predates a developer surface sends no key for it. Its
  // welcome must still open the wire.
  it('decodes a welcome whose server names fewer developer surfaces than this build knows', () => {
    const older = { ...welcome, developerSurfaces: { sourceControl: true, commitGraph: false, repositoryStatus: true, worktrees: true } }
    expect(decodeFrame(JSON.stringify(older))).toEqual(older)
  })

  it('decodes a welcome carrying a developer surface and a field this build does not know', () => {
    const newer = { ...welcome, developerSurfaces: { ...(welcome.developerSurfaces as object), notYetInvented: false }, somethingNew: 1 }
    expect(decodeFrame(JSON.stringify(newer))).toEqual(newer)
  })

  it('names the frame type and the field that failed', () => {
    let thrown: unknown
    try {
      decodeFrame(JSON.stringify({ ...welcome, developerSurfaces: { sourceControl: 'yes' } }))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(WireError)
    expect((thrown as WireError).frameType).toBe('studio_welcome')
    expect((thrown as WireError).field).toBe('developerSurfaces')
    expect((thrown as WireError).message).toContain('developerSurfaces')
  })
})

describe('studio-wire codec: decodeFrame errors', () => {
  it('throws WireError on invalid JSON', () => {
    expect(() => decodeFrame('{not json')).toThrow(WireError)
  })

  it('throws WireError on a JSON array instead of an object', () => {
    expect(() => decodeFrame('[]')).toThrow(WireError)
  })

  it('throws WireError on an unknown type', () => {
    expect(() => decodeFrame(JSON.stringify({ type: 'studio_bogus' }))).toThrow(WireError)
  })

  it('throws WireError on a known type with a malformed shape', () => {
    expect(() => decodeFrame(JSON.stringify({ type: 'studio_hello', protocolVersion: 1 }))).toThrow(WireError)
  })

  // `view` is optional, but a value outside the closed set would otherwise
  // reach the server as a connection that is neither mirror nor thin.
  it('throws WireError on a studio_hello whose view is not mirror or thin', () => {
    const hello = { type: 'studio_hello', protocolVersion: 1, clientId: 'c', clientKind: 'mobile', capabilities: [], credential: { kind: 'local' } }
    expect(decodeFrame(JSON.stringify(hello))).toMatchObject({ clientKind: 'mobile' })
    expect(decodeFrame(JSON.stringify({ ...hello, view: 'thin' }))).toMatchObject({ view: 'thin' })
    expect(() => decodeFrame(JSON.stringify({ ...hello, view: 'wide' }))).toThrow(WireError)
  })

  // The paging fields are optional, but when present they are typed: a cursor
  // that is not a string, or a limit that is not a finite number, would reach
  // the server's windowing arithmetic as-is.
  it('throws WireError on a studio_body_request whose paging fields are the wrong type', () => {
    expect(() => decodeFrame(JSON.stringify({ type: 'studio_body_request', tabId: 't', before: 7 }))).toThrow(WireError)
    expect(() => decodeFrame(JSON.stringify({ type: 'studio_body_request', tabId: 't', limit: '200' }))).toThrow(WireError)
    expect(decodeFrame(JSON.stringify({ type: 'studio_body_request', tabId: 't' }))).toEqual({ type: 'studio_body_request', tabId: 't' })
    expect(() => decodeFrame(JSON.stringify({ type: 'studio_body_request', tabId: 't', held: { epoch: 'e', rev: '3' } }))).toThrow(WireError)
    expect(() => decodeFrame(JSON.stringify({ type: 'studio_body_request', tabId: 't', held: 'e:3' }))).toThrow(WireError)
    const resuming = { type: 'studio_body_request', tabId: 't', held: { epoch: 'e', rev: 3 } }
    expect(decodeFrame(JSON.stringify(resuming))).toEqual(resuming)
  })

  it('decodes a studio_hello with a session credential (the browser Studio client -- no token, server resolves it from the ion_session cookie)', () => {
    const hello = {
      type: 'studio_hello',
      protocolVersion: 1,
      clientId: 'web-a1b2c3',
      clientKind: 'web',
      capabilities: ['terminal', 'git', 'files', 'questions', 'graph'],
      credential: { kind: 'session' },
    }
    expect(decodeFrame(JSON.stringify(hello))).toEqual(hello)
  })

  it('throws WireError on a credential kind outside the union', () => {
    const bad = {
      type: 'studio_hello',
      protocolVersion: 1,
      clientId: 'x',
      clientKind: 'desktop',
      capabilities: [],
      credential: { kind: 'oauth' },
    }
    expect(() => decodeFrame(JSON.stringify(bad))).toThrow(WireError)
  })
})

describe('studio-wire codec: binary frames', () => {
  it('round-trips a terminal-data frame', () => {
    const payload = new TextEncoder().encode('hello from a pty\n')
    const encoded = encodeBinary(BinaryChannel.TERMINAL_DATA, 'tab-1:instance-1', payload)
    const decoded = decodeBinary(encoded)
    expect(decoded.channel).toBe(BinaryChannel.TERMINAL_DATA)
    expect(decoded.key).toBe('tab-1:instance-1')
    expect(new TextDecoder().decode(decoded.payload)).toBe('hello from a pty\n')
  })

  it('round-trips a resize frame with binary (non-UTF8-safe) payload bytes', () => {
    const payload = new Uint8Array([0, 80, 0, 24]) // cols=80, rows=24 as two BE uint16s
    const encoded = encodeBinary(BinaryChannel.TERMINAL_RESIZE, 'tab-1:instance-1', payload)
    const decoded = decodeBinary(encoded)
    expect(decoded.channel).toBe(BinaryChannel.TERMINAL_RESIZE)
    expect(Array.from(decoded.payload)).toEqual([0, 80, 0, 24])
  })

  it('round-trips an empty key and empty payload', () => {
    const encoded = encodeBinary(BinaryChannel.FILE_CHUNK, '', new Uint8Array())
    const decoded = decodeBinary(encoded)
    expect(decoded.key).toBe('')
    expect(decoded.payload.length).toBe(0)
  })

  it('round-trips every Port Forward channel', () => {
    for (const channel of [BinaryChannel.PORT_DATA, BinaryChannel.PORT_END, BinaryChannel.PORT_CREDIT]) {
      const decoded = decodeBinary(encodeBinary(channel, 'stream-1', new Uint8Array([7])))
      expect(decoded.channel).toBe(channel)
      expect(decoded.key).toBe('stream-1')
      expect(Array.from(decoded.payload)).toEqual([7])
    }
  })

  it('throws WireError on a frame shorter than the header', () => {
    expect(() => decodeBinary(new Uint8Array([0x01, 0x00]))).toThrow(WireError)
  })

  it('throws WireError on an unknown channel byte', () => {
    const encoded = encodeBinary(BinaryChannel.TERMINAL_DATA, 'k', new Uint8Array([1, 2, 3]))
    encoded[0] = 0x09
    expect(() => decodeBinary(encoded)).toThrow(WireError)
  })

  it('throws WireError when the declared key length overruns the buffer', () => {
    const buf = new Uint8Array([0x01, 0xff, 0xff, 1, 2, 3])
    expect(() => decodeBinary(buf)).toThrow(WireError)
  })

  it('round-trips the latency probe and its answer', () => {
    // A frame a client that predates it would refuse to decode, which is why
    // the server sends it only to one advertising `wire-ping`.
    const ping = { type: 'studio_ping', nonce: 'abc123', t: 1_700_000_000_000 }
    expect(decodeFrame(JSON.stringify(ping))).toEqual(ping)

    const pong = { type: 'studio_pong', nonce: 'abc123', t: 1_700_000_000_042 }
    expect(decodeFrame(JSON.stringify(pong))).toEqual(pong)
  })

  it('refuses a probe with no nonce or a non-numeric clock', () => {
    expect(() => decodeFrame(JSON.stringify({ type: 'studio_ping', t: 1 }))).toThrow(WireError)
    expect(() => decodeFrame(JSON.stringify({ type: 'studio_pong', nonce: 'a', t: 'soon' }))).toThrow(WireError)
    expect(() => decodeFrame(JSON.stringify({ type: 'studio_ping', nonce: 7, t: 1 }))).toThrow(WireError)
  })
})
