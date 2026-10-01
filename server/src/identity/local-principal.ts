import { userInfo } from 'os'
import { warn as _warn, log as _log } from '../logger'
import type { SessionPrincipal } from '@ion/shared/types-engine'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('local-principal', msg, fields)
}
function log(msg: string, fields?: Record<string, unknown>): void {
  _log('local-principal', msg, fields)
}

/**
 * The local, no-identity-provider principal a server stamps on every
 * `start_session`/`send_prompt` when it fronts no OIDC issuer (manifest C1).
 * Mirrors the engine's `types.SessionPrincipal` (`engine/internal/types/identity.go`)
 * field-for-field via the shared `SessionPrincipal` type.
 *
 * `os.userInfo()` throws when the process has no resolvable passwd entry (some
 * container images run as a raw numeric UID with no `/etc/passwd` row). Node's
 * `UserInfo` carries no full-name/GECOS field on any platform, so `displayName`
 * is the same value as `username` here -- there is no richer name to fall
 * back to without shelling out to a platform-specific lookup, which nothing
 * else in this codebase does today.
 */
export function localPrincipal(): SessionPrincipal {
  let username: string
  try {
    username = userInfo().username
  } catch (err) {
    warn('os.userInfo() failed; falling back to uid-derived subject', { error: String(err) })
    const getuid = (process as { getuid?: () => number }).getuid
    if (typeof getuid === 'function') {
      try {
        const uid = getuid()
        return {
          subject: `local:uid-${uid}`,
          provider: 'os',
          kind: 'local',
          displayName: `uid-${uid}`,
        }
      } catch (uidErr) {
        warn('process.getuid() failed; falling back to unknown subject', { error: String(uidErr) })
      }
    }
    return {
      subject: 'local:unknown',
      provider: 'os',
      kind: 'local',
      displayName: 'unknown',
    }
  }
  return {
    subject: `local:${username}`,
    provider: 'os',
    kind: 'local',
    username,
    displayName: username,
  }
}

/**
 * The principal for a `{kind:'local'}` Studio connection (`hello.ts`'s
 * `LocalOnlyAuthPolicy`, the desktop's own connection to its own engine):
 * the engine's signed-in Entra identity (`oidc_identity`) when
 * one exists, falling back to `localPrincipal()` (the OS username) only
 * when nobody is signed in.
 *
 * This is the explicit precedence decision for one person's two sign-in
 * paths (local desktop vs. relay/paired/bearer): a local connection used to
 * always stamp the OS username even while the same engine was signed in to
 * Entra, disagreeing with the relay/bearer door's principal
 * (`auth/bearer.ts`) for the identical person. `identity.user` mirrors
 * `bearer.ts`'s own `name = payload.name || preferred_username || sub`
 * precedence (`EntraIdentity.user`'s doc comment: "preferred_username → oid")
 * so both doors converge on the same attribution string for the same token
 * shape, rather than differing on which fallback field each door picked.
 *
 * The engine round trip (`getSignedInIdentityIfEngineConnected`) skips
 * itself entirely, never even attempted, unless the engine bridge already
 * has a live connection -- see that function's doc comment in
 * `oauth/entra-flow.ts` for why. Its own failure (no identity provider
 * configured, request error) still falls back to `localPrincipal()` rather
 * than refusing an otherwise-valid local connection -- the local socket's
 * own transport check is what establishes trust here, not this identity
 * enrichment.
 *
 * `oauth/entra-flow.ts` (and, transitively, `../state`'s `engineBridge`
 * singleton and everything it constructs) is imported dynamically, not at
 * module scope: `local-principal.ts` is a leaf module reached from many
 * lightweight call sites (git identity resolution, tab sync, settings),
 * several exercised by unit tests that mock the engine bridge minimally or
 * not at all. A static import here would force every one of those tests to
 * also satisfy `state.ts`'s module-load construction, for a dependency most
 * of them never actually exercise. The dynamic import defers that cost to
 * the one caller (`hello.ts`'s `{kind:'local'}` branch) that needs it.
 */
export async function resolveLocalConnectionPrincipal(): Promise<SessionPrincipal> {
  try {
    const [{ getSignedInIdentityIfEngineConnected }, { providerFromIssuer }] = await Promise.all([
      import('../oauth/entra-flow'),
      import('../auth/bearer'),
    ])
    const identity = await getSignedInIdentityIfEngineConnected()
    if (identity && identity.oid && identity.user) {
      log('local connection: using signed-in engine identity', { subject: identity.oid })
      return {
        subject: identity.oid,
        provider: identity.issuer ? providerFromIssuer(identity.issuer) : 'entra',
        kind: 'operator',
        username: identity.username || undefined,
        displayName: identity.user,
      }
    }
  } catch (err) {
    warn('local connection: signed-in identity check failed; falling back to OS username', { error: String(err) })
  }
  return localPrincipal()
}

/**
 * Stamps the engine's signed-in identity as telemetry attribution on a
 * `kind: 'local'` principal (the OS-username fallback a `start_session` uses
 * for a tab with no registered owner). Subject, username, and displayName
 * stay the OS account: they key this person's saved git credentials and
 * per-principal files, which must not move. Only `attribution` changes, and
 * the engine reads it first when it labels a run's telemetry and logs, so a
 * signed-in person's work carries the same user as the rest of their
 * engine's lines instead of their OS login name.
 *
 * Any other principal, or no signed-in identity, is returned unchanged.
 */
export async function withSignedInAttribution(principal: SessionPrincipal): Promise<SessionPrincipal> {
  if (principal.kind !== 'local') return principal
  try {
    const { getSignedInIdentityIfEngineConnected } = await import('../oauth/entra-flow')
    const identity = await getSignedInIdentityIfEngineConnected()
    if (identity?.user) {
      log('local principal: attributing to signed-in engine identity', { subject: principal.subject })
      return { ...principal, attribution: identity.user }
    }
    log('local principal: no signed-in engine identity; attribution stays the OS username', { subject: principal.subject })
  } catch (err) {
    warn('local principal: signed-in identity check failed; attribution stays the OS username', { subject: principal.subject, error: String(err) })
  }
  return principal
}
