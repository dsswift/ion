/**
 * The sealed fixture is opened here by the TypeScript implementation and by
 * the iOS client's Swift implementation (`ios/IonRemoteTests/StudioWire/`),
 * so both languages are held to one set of bytes: the envelope layout, the
 * channel id derivation, and the hello's HMAC proof.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { openRelayFrame } from '../relay-envelope'
import { decodeBinary, decodeFrame } from '../codec'
import { createAuthProof, deriveChannelId } from '../../e2e'

interface SealedCase {
  plaintext: string
  envelope: string
}

interface SealedFixture {
  key: string
  channelId: string
  text: SealedCase
  binary: SealedCase
  doorbell: SealedCase
  authProof: { nonce: string; proof: string }
  relayProof: { tag: string; tagBytes: string; proof: string }
}

const fixture = JSON.parse(readFileSync(join(__dirname, '..', '__fixtures__', 'sealed', 'relay-envelope.json'), 'utf-8')) as SealedFixture
const key = Buffer.from(fixture.key, 'base64')

describe('sealed fixture', () => {
  it('opens the text envelope to the exact frame that was sealed', () => {
    const opened = openRelayFrame(fixture.text.envelope, key)
    expect(opened?.isBinary).toBe(false)
    expect(opened?.bytes.toString('utf-8')).toBe(fixture.text.plaintext)
    expect(decodeFrame(fixture.text.plaintext).type).toBe('studio_event')
  })

  it('opens the binary envelope and honors its bin flag', () => {
    const opened = openRelayFrame(fixture.binary.envelope, key)
    expect(opened?.isBinary).toBe(true)
    expect(opened?.bytes.toString('base64')).toBe(fixture.binary.plaintext)
    const decoded = decodeBinary(new Uint8Array(opened!.bytes))
    expect(decoded.key).toBe('tab-1:inst-1')
    expect([...decoded.payload]).toEqual([0, 1, 2, 253, 254, 255])
  })

  it('opens a doorbell envelope, whose plaintext push fields change nothing about the sealed frame', () => {
    expect(openRelayFrame(fixture.doorbell.envelope, key)?.bytes.toString('utf-8')).toBe(fixture.doorbell.plaintext)
  })

  it('refuses the wrong key', () => {
    expect(openRelayFrame(fixture.text.envelope, Buffer.alloc(32, 9))).toBeNull()
  })

  it('derives the channel id and both hello proofs the fixture records', () => {
    expect(deriveChannelId(key)).toBe(fixture.channelId)
    expect(createAuthProof(fixture.authProof.nonce, key)).toBe(fixture.authProof.proof)
    // Over a relay the proof is an HMAC over a fixed tag. The tag is decoded
    // as base64 like any nonce, which keeps only its first three bytes.
    expect(Buffer.from(fixture.relayProof.tag, 'base64').toString('base64')).toBe(fixture.relayProof.tagBytes)
    expect(createAuthProof(fixture.relayProof.tag, key)).toBe(fixture.relayProof.proof)
  })
})
