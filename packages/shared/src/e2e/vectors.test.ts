/**
 * Cross-language test vectors for the pairing crypto and the relay envelope.
 * This test computes them with the TypeScript implementation and compares the
 * checked-in fixture; the Go Studio client (engine/internal/studioclient)
 * reads the same fixture, so the two implementations cannot drift apart
 * without one side failing. It also carries the Studio wire and relay envelope
 * versions, which the Go client speaks as copies. Regenerate after a
 * deliberate change with
 * UPDATE_E2E_VECTORS=1.
 */
import { createCipheriv, createPrivateKey, createPublicKey } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { createAuthProof, deriveChannelId, deriveSharedSecret, E2E_KEY_DERIVATION_VERSION } from './index'
import { openRelayFrame, RELAY_ENVELOPE_VERSION } from '../studio-wire/relay-envelope'
import { PROTOCOL_VERSION } from '../studio-wire/version'

const FIXTURE = join(__dirname, '__fixtures__', 'e2e-vectors.json')

const CLIENT_PRIVATE = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'
const SERVER_PRIVATE = '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb'
const HTTP_NONCE = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex').toString('base64')
const ENVELOPE_NONCE = '0f0e0d0c0b0a090807060504'
const PLAINTEXT = JSON.stringify({ type: 'studio_action', id: 'fleet-1', action: 'environment.server.info', args: [] })

function publicKeyOf(privateHex: string): Buffer {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(privateHex, 'hex')]), format: 'der', type: 'pkcs8' })
  return Buffer.from(createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(12))
}

function computeVectors() {
  const clientPublic = publicKeyOf(CLIENT_PRIVATE)
  const serverPublic = publicKeyOf(SERVER_PRIVATE)
  const shared = deriveSharedSecret(Buffer.from(CLIENT_PRIVATE, 'hex'), serverPublic)
  const cipher = createCipheriv('aes-256-gcm', shared, Buffer.from(ENVELOPE_NONCE, 'hex'), { authTagLength: 16 })
  const sealed = Buffer.concat([cipher.update(PLAINTEXT, 'utf-8'), cipher.final(), cipher.getAuthTag()])
  const envelope = JSON.stringify({ v: RELAY_ENVELOPE_VERSION, nonce: Buffer.from(ENVELOPE_NONCE, 'hex').toString('base64'), ciphertext: sealed.toString('base64') })
  return {
    keyDerivationInfo: E2E_KEY_DERIVATION_VERSION,
    relayEnvelopeVersion: RELAY_ENVELOPE_VERSION,
    studioProtocolVersion: PROTOCOL_VERSION,
    clientPrivateKey: CLIENT_PRIVATE,
    clientPublicKey: clientPublic.toString('base64'),
    serverPrivateKey: SERVER_PRIVATE,
    serverPublicKey: serverPublic.toString('base64'),
    sharedSecret: shared.toString('hex'),
    channelId: deriveChannelId(shared),
    httpNonce: HTTP_NONCE,
    httpProof: createAuthProof(HTTP_NONCE, shared),
    relayProof: createAuthProof('relay', shared),
    envelopePlaintext: PLAINTEXT,
    envelope,
  }
}

describe('e2e cross-language vectors', () => {
  it('match the checked-in fixture the Go client reads', () => {
    const vectors = computeVectors()
    if (process.env.UPDATE_E2E_VECTORS === '1') writeFileSync(FIXTURE, JSON.stringify(vectors, null, 2) + '\n')
    expect(JSON.parse(readFileSync(FIXTURE, 'utf-8'))).toEqual(vectors)
  })

  it('agree from both sides of the exchange, and the envelope opens with the TypeScript opener', () => {
    const v = computeVectors()
    const fromServer = deriveSharedSecret(Buffer.from(SERVER_PRIVATE, 'hex'), Buffer.from(v.clientPublicKey, 'base64'))
    expect(fromServer.toString('hex')).toBe(v.sharedSecret)
    expect(openRelayFrame(v.envelope, fromServer)?.bytes.toString('utf-8')).toBe(PLAINTEXT)
  })
})
