/**
 * The Studio wire protocol version (manifest contract C3).
 *
 * A server accepts a `studio_hello` at this version or one below
 * (`PROTOCOL_VERSION - 1`), so a client one release behind the server it is
 * talking to still connects. Anything else is refused with
 * `requiredProtocolVersion: PROTOCOL_VERSION` so the client knows exactly
 * what to upgrade to.
 *
 * Bumping this number is a breaking-wire-shape decision — see
 * `docs/protocol/studio-wire.md` and `scripts/check-studio-wire.sh`, which
 * fails a fixture change with no matching `## v<N>` doc note.
 */
export const PROTOCOL_VERSION = 1

/** True when `version` is one the server accepts from an incoming hello. */
export function isSupportedProtocolVersion(version: number): boolean {
  return version === PROTOCOL_VERSION || version === PROTOCOL_VERSION - 1
}
