/**
 * Deep-link capability token.
 *
 * ── Why a token at all ───────────────────────────────────────────────────────
 * `ion://terminal?cmd=…` is arbitrary command execution, and `ion://prompt`
 * puts words in an agent's mouth. A URL scheme is reachable from a WEB PAGE, so
 * without a trust boundary a link on any site could run a command on this
 * machine on one click. That is a known hole in other editors' URI handlers and
 * it is not one worth reproducing.
 *
 * ── Why a FILE token is a real boundary and not security theatre ─────────────
 * The token lives in a 0600 file under ~/.ion. The asymmetry that makes it work:
 *
 *   - A LOCAL PROCESS can read it. `dev run`, a Makefile, a shell script — all
 *     of them can already spawn whatever they like as this user, so handing them
 *     full deep-link capability grants nothing they did not already have. The
 *     token is an identity check, not a privilege grant.
 *   - A WEB PAGE cannot read it. No amount of markup or script in a browser can
 *     read a local 0600 file, so a published link physically cannot carry a
 *     valid token, no matter who wrote it or how it is disguised.
 *
 * So "did this request come from something already running on this machine?"
 * has a reliable answer, and the untrusted path can be routed through a human
 * confirmation instead of being refused outright (which would kill the
 * shareable-prompt use case) or executed blindly (which would be the hole).
 *
 * ── What this module deliberately does NOT do ────────────────────────────────
 * No expiry, no rotation, no per-request nonce. A local process can re-read the
 * file at any moment, so rotating it stops nothing that matters, and an expiry
 * would break `dev run` in a long-lived shell for no gain. The threat model is
 * "code that cannot read my filesystem", and file permissions answer exactly
 * that.
 */

import { randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('deeplink', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('deeplink', msg, fields)
}

export const DEEPLINK_TOKEN_FILE = join(homedir(), '.ion', 'deeplink.token')

/** Cached so the common path does not hit the filesystem per request. */
let cachedToken: string | null = null

/**
 * Return the capability token, minting it on first use.
 *
 * Returns an empty string when the token cannot be established (unwritable
 * home, for example). An empty token is treated as "no token available" by
 * `isTrustedToken`, which fails CLOSED: every request is then untrusted and
 * routed through confirmation. A deep link that needs a human is a degraded
 * experience; one that executes without a trust check is a vulnerability.
 */
export function getDeepLinkToken(): string {
  if (cachedToken) return cachedToken

  try {
    if (existsSync(DEEPLINK_TOKEN_FILE)) {
      const existing = readFileSync(DEEPLINK_TOKEN_FILE, 'utf-8').trim()
      if (existing.length >= 32) {
        // Re-assert the mode: a token that became world-readable (an errant
        // chmod, a restore from a permissive backup) is no longer a boundary.
        try {
          chmodSync(DEEPLINK_TOKEN_FILE, 0o600)
        } catch (err) {
          warn('could not re-assert token file mode', { error: String(err) })
        }
        cachedToken = existing
        return cachedToken
      }
      warn('token file too short, minting a fresh token', { length: existing.length })
    }

    const minted = randomBytes(32).toString('hex')
    mkdirSync(dirname(DEEPLINK_TOKEN_FILE), { recursive: true })
    // mode on write AND an explicit chmod: the `mode` option is masked by the
    // process umask, so it alone does not guarantee 0600.
    writeFileSync(DEEPLINK_TOKEN_FILE, minted + '\n', { mode: 0o600 })
    chmodSync(DEEPLINK_TOKEN_FILE, 0o600)
    cachedToken = minted
    log('minted deep-link token', { path: DEEPLINK_TOKEN_FILE })
    return cachedToken
  } catch (err) {
    warn('could not establish deep-link token; all deep links will require confirmation', {
      error: String(err),
    })
    return ''
  }
}

/**
 * Whether a request-supplied token matches this machine's token.
 *
 * Compared with `timingSafeEqual` — the comparison is against a local secret a
 * caller may probe repeatedly, so it is kept constant-time rather than relying
 * on the difficulty of timing a local IPC path.
 */
export function isTrustedToken(supplied: string | undefined | null): boolean {
  if (!supplied) return false
  const actual = getDeepLinkToken()
  if (!actual) return false

  const a = Buffer.from(supplied, 'utf-8')
  const b = Buffer.from(actual, 'utf-8')
  // timingSafeEqual throws on length mismatch, which is itself a length oracle;
  // the lengths of both are non-secret (fixed-width hex), so an early false is
  // no leak.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Test seam: drop the cache so a test can re-mint against a temp home. */
export function resetDeepLinkTokenCacheForTests(): void {
  cachedToken = null
}
