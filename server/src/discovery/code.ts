/**
 * discovery/code — minting the short one-time code typed to pair with a
 * server found on the LAN.
 *
 * The alphabet, the length, the display grouping, and the rule for reading a
 * typed code back live in `@ion/shared/discovery-code`, because the client
 * that builds a pairing link has to recognise a short code too. Only minting
 * is here: it needs a cryptographic RNG, and no client should be able to mint
 * one. The names below are re-exported so this module stays the server's one
 * import site for discovery codes.
 */
import { randomInt } from 'crypto'
import { DISCOVERY_CODE_ALPHABET, DISCOVERY_CODE_LENGTH } from '@ion/shared/discovery-code'

export { DISCOVERY_CODE_LENGTH, formatDiscoveryCode, normalizeDiscoveryCode } from '@ion/shared/discovery-code'

export function mintDiscoveryCode(): string {
  let out = ''
  for (let i = 0; i < DISCOVERY_CODE_LENGTH; i++) out += DISCOVERY_CODE_ALPHABET[randomInt(DISCOVERY_CODE_ALPHABET.length)]
  return out
}
