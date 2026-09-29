/**
 * discovery-code — the short one-time code typed to pair with a server found
 * on the LAN, and the rules for reading one back.
 *
 * A pairing link carries a 128-bit code nobody types. A discovered server is
 * paired by reading a code off one screen and typing it on another, so the
 * code is short -- and a short secret on a LAN must not be guessable. Eight
 * characters from a 31-symbol alphabet with no look-alikes (no I, L, O, 0, 1)
 * is about 8.5e11 values, and the server burns the code after a handful of
 * wrong guesses, so guessing is not a strategy. Shown grouped as XXXX-XXXX;
 * accepted with or without the dash, in any case.
 *
 * The alphabet lives here, not beside the minter, because BOTH ends need it:
 * the server mints and verifies, and the client that builds the pairing link
 * has to recognise a short code as a legal code rather than refusing it as
 * malformed. Minting stays in `server/src/discovery/code.ts` — it needs a
 * cryptographic RNG, and nothing in a client should be able to mint one.
 */

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const DISCOVERY_CODE_LENGTH = 8
/** The characters a discovery code is drawn from; exported for the minter. */
export const DISCOVERY_CODE_ALPHABET = ALPHABET

/** `ABCD-EFGH` for display. */
export function formatDiscoveryCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/**
 * The canonical form of what a person typed, or null when it is not shaped
 * like a discovery code (a 32-hex pairing-link code is a different shape and
 * is recognised by the link parser, not here).
 */
export function normalizeDiscoveryCode(input: string): string | null {
  const compact = input.replace(/[\s-]/g, '').toUpperCase()
  if (compact.length !== DISCOVERY_CODE_LENGTH) return null
  for (const ch of compact) if (!ALPHABET.includes(ch)) return null
  return compact
}
