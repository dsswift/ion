/**
 * Pairing-link parsing, shared by every client that admits a paired
 * environment (spec 13, manifest C6/C9). A server mints
 * `ion-studio://pair?code=<hex>&url=<http base>&env=<server label>`
 * (`server/src/auth/pairing-links.ts#formatPairingLink`); the client pastes
 * or receives that link and needs its three parts back, validated, before
 * it runs the `POST /auth/pair` exchange.
 *
 * A link's code is either the minted 128-bit hex one or the short code a
 * person read off a discovered server's screen (Nearby builds its link around
 * that one); both are accepted and canonicalised here.
 *
 * Pure so the desktop renderer (the dialog), the desktop main process (the
 * exchange), and a test can all use the one parser.
 */
import { normalizeDiscoveryCode } from './discovery-code'

export const PAIRING_LINK_PROTOCOL = 'ion-studio:'
export const PAIRING_LINK_HOST = 'pair'

/**
 * A relay pairing channel the link also names (optional): the client can
 * complete the same exchange through the relay when `url` is unreachable.
 * `key` is the relay's PSK when it runs in PSK mode.
 */
export interface ParsedPairingRelay {
  url: string
  channel: string
  key?: string
}

export interface ParsedPairingLink {
  /**
   * The one-time code, canonicalised: 32 lowercase hex for a minted link, or
   * the compact upper-case form of a short discovery code (`FSSE2S5J`) for a
   * server found under Nearby. The server accepts either.
   */
  code: string
  /** The server's advertised HTTP base URL, no trailing slash. */
  url: string
  /** The server's label at mint time; a default for the client's catalog entry. May be empty. */
  label: string
  /** Present when the link also names a relay pairing channel. */
  relay?: ParsedPairingRelay
}

export type PairingLinkParseResult =
  | { ok: true; link: ParsedPairingLink }
  | { ok: false; reason: 'not_a_link' | 'wrong_scheme' | 'missing_code' | 'bad_code' | 'missing_url' | 'bad_url' }

/** A minted link's code: 128 bits, nobody types it. */
const CODE_PATTERN = /^[0-9a-f]{32}$/

/**
 * The code a link may carry, canonicalised, or null when it is neither shape.
 * A Nearby pairing builds its link around the short code a person read off
 * the other screen, so refusing everything but hex would refuse every Nearby
 * pairing before the network was touched.
 */
function canonicalLinkCode(raw: string): string | null {
  if (CODE_PATTERN.test(raw)) return raw
  return normalizeDiscoveryCode(raw)
}

/** Normalizes an http(s) base URL: parses, requires http/https, drops a trailing slash. Returns null when unusable. */
export function normalizeServerHttpBase(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.host) return null
  parsed.hash = ''
  parsed.search = ''
  return parsed.toString().replace(/\/$/, '')
}

export function parsePairingLink(text: string): PairingLinkParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, reason: 'not_a_link' }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'not_a_link' }
  }
  if (parsed.protocol !== PAIRING_LINK_PROTOCOL || parsed.host !== PAIRING_LINK_HOST) return { ok: false, reason: 'wrong_scheme' }
  const rawCode = parsed.searchParams.get('code') ?? ''
  if (!rawCode) return { ok: false, reason: 'missing_code' }
  const code = canonicalLinkCode(rawCode)
  if (!code) return { ok: false, reason: 'bad_code' }
  const rawUrl = parsed.searchParams.get('url') ?? ''
  if (!rawUrl) return { ok: false, reason: 'missing_url' }
  const url = normalizeServerHttpBase(rawUrl)
  if (!url) return { ok: false, reason: 'bad_url' }
  const label = (parsed.searchParams.get('env') ?? '').trim()
  const relayUrl = (parsed.searchParams.get('relay') ?? '').trim()
  const channel = (parsed.searchParams.get('channel') ?? '').trim()
  const relayKey = (parsed.searchParams.get('relayKey') ?? '').trim()
  // A relay is only usable when both its address and its channel parse; a
  // half-named relay is ignored rather than refused, since the LAN url alone
  // is a complete link.
  const relay: ParsedPairingRelay | undefined = relayUrl && CODE_PATTERN.test(channel) && /^wss?:\/\//.test(relayUrl)
    ? (relayKey ? { url: relayUrl, channel, key: relayKey } : { url: relayUrl, channel })
    : undefined
  return { ok: true, link: relay ? { code, url, label, relay } : { code, url, label } }
}

/** Human-readable reason for the dialog. */
export function describePairingLinkFailure(reason: Exclude<PairingLinkParseResult, { ok: true }>['reason']): string {
  switch (reason) {
    case 'not_a_link': return 'Paste the whole pairing link (it starts with ion-studio://pair).'
    case 'wrong_scheme': return 'That is not a pairing link. A pairing link starts with ion-studio://pair.'
    case 'missing_code': return 'The pairing link has no code.'
    case 'bad_code': return 'The pairing code is malformed. A minted link carries a 32-character code; a code read off a nearby server is eight characters (XXXX-XXXX).'
    case 'missing_url': return 'The pairing link does not name the server address. Mint it with a server that sets pairing.advertiseUrl or has a resolvable hostname.'
    case 'bad_url': return 'The server address in the pairing link is not an http(s) URL.'
  }
}
