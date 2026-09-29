/**
 * The server nonce `GET /auth/config` returns (manifest C6), and that a
 * `paired` credential's HMAC proof is computed over (manifest requirement:
 * "the hello carries the nonce echo from `/auth/config?nonce`").
 *
 * `StudioCredential`'s `{kind:'paired', clientId, proof}` shape carries no
 * nonce field of its own -- the wire never echoes the nonce value back, so
 * verification instead tries the proof against every currently-valid nonce.
 * Two are kept valid at a time (current + previous) specifically to bridge
 * the gap between "client fetched the nonce from `/auth/config`" and "client
 * sent `studio_hello`": without the previous nonce, a rotation landing in
 * that window would refuse a perfectly legitimate proof.
 */
import { randomBytes } from 'crypto'

/** How long a minted nonce stays the "current" one before the next `currentNonce()` call rotates it. */
const NONCE_TTL_MS = 5 * 60 * 1000

/** Test-only override of `NONCE_TTL_MS`, so rotation can be exercised without a real 5-minute wait. */
let ttlMsOverride: number | null = null

interface NonceRecord {
  value: string
  mintedAt: number
}

let current: NonceRecord | null = null
let previous: NonceRecord | null = null

function mint(): NonceRecord {
  return { value: randomBytes(32).toString('base64url'), mintedAt: Date.now() }
}

/** The current nonce, minting (and rotating the prior one to `previous`) when the active one has expired. */
export function currentNonce(): string {
  const ttl = ttlMsOverride ?? NONCE_TTL_MS
  if (!current || Date.now() - current.mintedAt > ttl) {
    previous = current
    current = mint()
  }
  return current.value
}

/** Every nonce a `paired` proof may currently validate against, current first. */
export function candidateNonces(): string[] {
  currentNonce()
  const out: string[] = []
  if (current) out.push(current.value)
  if (previous) out.push(previous.value)
  return out
}

/** TEST ONLY. Resets nonce state between test cases. */
export function _resetNonceForTest(): void {
  current = null
  previous = null
  ttlMsOverride = null
}

/** TEST ONLY. Overrides the nonce TTL so rotation can be exercised without a real 5-minute wait. Pass null to restore the default. */
export function _setNonceTtlForTest(ms: number | null): void {
  ttlMsOverride = ms
}
