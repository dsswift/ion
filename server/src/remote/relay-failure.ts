// relay-failure.ts — tell a relay failure that retrying will fix from one it
// will not.
//
// The relay client treated every failure as transient and fed it into the same
// exponential backoff. That is right for a network blip and wrong for a
// configuration problem, and the difference is not academic: an unsigned-in
// user produced this pair every ~14 seconds, indefinitely, while the settings
// UI showed nothing but "Disconnected".
//
//   relay_client: credential fetch failed, deferring to backoff
//   relay_client: reconnecting
//
// Retrying a missing sign-in cannot succeed. It burns a token-endpoint request
// per attempt, and — because the only visible state is a three-value connection
// enum with no reason — leaves the operator with no way to learn what to fix
// short of reading engine.jsonl.
//
// So failures are classified. Transient keeps the backoff. Permanent stops,
// latches, and surfaces a reason; a credential change or an explicit retry
// clears the latch. Unknown keeps retrying but escalates rather than looping
// silently forever.

/** Whether retrying can plausibly succeed without operator action. */
export type RelayFailureClass = 'transient' | 'permanent' | 'unknown'

export interface RelayFailure {
  class: RelayFailureClass
  /** Stable machine-readable code for the UI to switch on. */
  reason: string
  /** Human-readable detail; safe to show, never contains a token. */
  detail?: string
}

/**
 * Close codes the relay and the WebSocket spec define.
 *
 * 4401 is deliberately transient: it means the token expired, and the next
 * connect mints a fresh one — the retry is the fix.
 */
export const CLOSE_CODE_TOKEN_EXPIRED = 4401
/** Authenticated but not permitted on this channel. Retrying cannot help. */
export const CLOSE_CODE_FORBIDDEN = 4403
/** The channel does not exist / is not provisioned for this account. */
export const CLOSE_CODE_NO_CHANNEL = 4404

/**
 * Classify a credential-fetch failure.
 *
 * The engine surfaces these as message strings rather than typed errors, so
 * matching is textual. Matching is deliberately conservative: anything not
 * recognised is 'unknown' and still retries, because misclassifying a
 * transient failure as permanent would strand a connection that would have
 * healed on its own.
 */
export function classifyCredentialError(err: Error): RelayFailure {
  const msg = (err?.message ?? '').toLowerCase()

  // Not signed in / no grant to refresh. Needs an interactive login.
  if (
    msg.includes('no credentials') ||
    msg.includes('not signed in') ||
    msg.includes('no token returned') ||
    msg.includes('no refresh token') ||
    msg.includes('invalid_grant') ||
    msg.includes('refresh_token_already_used')
  ) {
    return {
      class: 'permanent',
      reason: 'sign_in_required',
      detail: 'No usable credential for the relay. Sign in to reconnect.',
    }
  }

  // Consent revoked or the app is not authorised in the tenant.
  if (
    msg.includes('consent') ||
    msg.includes('unauthorized_client') ||
    msg.includes('access_denied') ||
    msg.includes('aadsts')
  ) {
    return {
      class: 'permanent',
      reason: 'consent_required',
      detail: 'The relay application is not authorised for this account.',
    }
  }

  // A misconfigured scope will fail identically on every attempt.
  if (msg.includes('invalid_scope') || msg.includes('scope')) {
    return {
      class: 'permanent',
      reason: 'scope_misconfigured',
      detail: 'The configured OIDC scope was rejected by the identity provider.',
    }
  }

  // Token endpoint unreachable or failing: retrying is exactly right.
  if (
    msg.includes('timeout') ||
    msg.includes('etimedout') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('enetunreach') ||
    msg.includes('socket hang up') ||
    msg.includes('502') || msg.includes('503') || msg.includes('504')
  ) {
    return { class: 'transient', reason: 'network', detail: 'Could not reach the token endpoint.' }
  }

  return { class: 'unknown', reason: 'credential_error', detail: err?.message }
}

/** Classify a WebSocket close. */
export function classifyCloseCode(code: number, reason: string): RelayFailure {
  switch (code) {
    case CLOSE_CODE_TOKEN_EXPIRED:
      // The retry IS the remedy: the next connect mints a fresh token.
      return { class: 'transient', reason: 'token_expired' }
    case CLOSE_CODE_FORBIDDEN:
      return {
        class: 'permanent',
        reason: 'forbidden',
        detail: reason || 'The relay rejected this device for this channel.',
      }
    case CLOSE_CODE_NO_CHANNEL:
      return {
        class: 'permanent',
        reason: 'channel_missing',
        detail: reason || 'The configured relay channel does not exist.',
      }
    case 1006: // abnormal closure
    case 1012: // service restart
    case 1013: // try again later
    case 1001: // going away
      return { class: 'transient', reason: 'relay_restart' }
    case 1000: // normal
      return { class: 'transient', reason: 'closed' }
    default:
      // 4xxx is the relay's private range; treat an unrecognised one as
      // policy (permanent) only when it is explicitly in the 4400-4499
      // auth band, otherwise keep retrying.
      if (code >= 4400 && code <= 4499) {
        return { class: 'permanent', reason: 'rejected', detail: reason || `Relay closed with ${code}.` }
      }
      return { class: 'unknown', reason: 'closed_unknown', detail: reason || `Relay closed with ${code}.` }
  }
}

/**
 * Attempts before an 'unknown' failure escalates to ERROR.
 *
 * Unknown failures keep retrying — misclassifying a transient as permanent is
 * the worse error — but a silent infinite loop is what this module exists to
 * end, so an unknown that never resolves becomes loud.
 */
export const UNKNOWN_FAILURE_ESCALATE_AFTER = 10
