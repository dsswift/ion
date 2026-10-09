/**
 * hello — the `studio_hello` -> `studio_welcome`/`studio_refused` handshake
 * (manifest contract C3, Phase 2 pseudocode).
 *
 * `AuthPolicy` is the seam child 08 (server-auth) replaces: this child ships
 * `LocalOnlyAuthPolicy`, which accepts `{kind:'local'}` ONLY on the local
 * Unix-socket/named-pipe transport (never TCP) and grants the server's local
 * principal every scope in manifest C4. `{kind:'paired'}` and
 * `{kind:'bearer'}` are refused unconditionally — there is no OIDC/pairing
 * resolution yet — but the wire mechanics (hello parsing, protocol-version
 * window, welcome/refused framing, event subscription) are the same
 * mechanics child 08 plugs into; only `authenticate()` changes.
 */
import { createHash } from 'crypto'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import type { StudioCredential, StudioFrame, StudioPrincipalSummary, StudioSnapshot, StudioView, Scope } from '@ion/shared/studio-wire/types'
import { SCOPES } from '@ion/shared/studio-wire/types'
import { PORT_FORWARD_CAPABILITY } from '@ion/shared/port-forward'
import { isSupportedProtocolVersion, PROTOCOL_VERSION } from '@ion/shared/studio-wire/version'
import { localPrincipal } from '../identity/local-principal'
import { registerPrincipal } from '../identity/principal-registry'
import { registerPresence } from './presence'
import { computeSettingsHiddenGroups } from './settings-visibility'
import { computeDeveloperSurfaces, projectSnapshotForSurfaces } from './developer-surfaces'
import { enterprisePolicyHash } from '../enterprise-policy-publish'
import { log as _log, warn as _warn } from '../logger'
import { withSpan } from '../tracing/op-span'
import type { Connection, ConnectionRegistry, ConnectionTransport } from './connection'
import type { CredentialsStore } from '../auth/credentials-store'
import type { EnvironmentRelay } from '@ion/shared/studio-wire/relay-envelope'
import { acceptPreVerifiedPaired } from '../auth/paired'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('studio-hello', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('studio-hello', msg, fields)
}

/**
 * `expiresAt` (bearer only) and `reason` (refusal only) are additive fields
 * child 08's real doors (`auth/bearer.ts`, `auth/paired.ts`) populate. Neither
 * reaches the wire directly -- `handleHello` always sends
 * `studio_refused{reason:'unauthorized'}` regardless of `reason`, since
 * `StudioRefusalReason` has no room for a per-door classification -- but
 * `reason` lets every door's caller (and its own tests) log and assert the
 * specific refusal cause per the manifest's "every decision logs ... reason"
 * requirement, and `expiresAt` lets `Connection.authExpiresAt` track a bearer
 * token's expiry for a future expiry-driven close.
 *
 * `claims` (bearer only, additive) carries the raw token claims a door
 * chooses to preserve beyond what `principal` echoes back to the client on
 * `studio_welcome` -- e.g. `roles` for FR-03's per-principal tool policy.
 * Never sent over the wire: `handleHello` stores it in the principal registry
 * keyed by subject and nowhere else, exactly because `principal` (which IS
 * echoed) must stay safe to hand back to the authenticating client itself.
 */
export type AuthResult =
  | { ok: true; principal: StudioPrincipalSummary; scopes: Scope[]; expiresAt?: number; claims?: Record<string, unknown> }
  | { ok: false; reason?: string }

/**
 * The credential-resolution seam. `server/src/protocol/*` depends only on
 * this interface, never on a concrete implementation, so child 08 can swap
 * in real OIDC/pairing resolution without touching hello/connection/events/
 * actions/commands wiring.
 */
export interface AuthPolicy {
  /**
   * `sessionCookie` is the connection's `ion_session` cookie value (from
   * `Connection.sessionCookie`), or null when absent -- additive to this
   * interface for the `{kind:'session'}` credential (spec 18 successor); a
   * policy that never resolves that kind (like `LocalOnlyAuthPolicy` below)
   * simply ignores the parameter.
   */
  authenticate(credential: StudioCredential, transport: ConnectionTransport, sessionCookie: string | null): Promise<AuthResult>
}

/** Every scope in manifest C4 — what the local, no-identity-provider principal is granted. */
const ALL_SCOPES: readonly Scope[] = SCOPES

export class LocalOnlyAuthPolicy implements AuthPolicy {
  async authenticate(credential: StudioCredential, transport: ConnectionTransport, _sessionCookie: string | null): Promise<AuthResult> {
    if (credential.kind === 'local') {
      if (transport !== 'local') {
        warn('local credential presented on a non-local transport; refusing', { transport })
        return { ok: false }
      }
      // Always the OS account, signed in to an identity provider or not.
      // Everything this person stores on the server is keyed by this
      // subject, so it must be the same on every connect.
      const principal = localPrincipal()
      log('local credential accepted on local transport', { subject: principal.subject, provider: principal.provider, kind: principal.kind })
      return {
        ok: true,
        principal: {
          subject: principal.subject,
          displayName: principal.displayName ?? principal.subject,
          provider: principal.provider,
          kind: principal.kind,
          username: principal.username,
        },
        scopes: [...ALL_SCOPES],
      }
    }
    // {kind:'paired'}, {kind:'bearer'}, {kind:'session'}: no OIDC/pairing
    // resolution exists here (child 08, server-auth; DefaultAuthPolicy is
    // the real resolver). Refuse rather than half-implement it.
    warn('credential kind has no resolver yet; refusing unauthorized', { kind: credential.kind, transport })
    await Promise.resolve()
    return { ok: false }
  }
}

/** Stable content hash used to detect an enterprise-policy change worth re-sending. */
export function hashEnterprisePolicy(policy: EnterprisePolicy | null): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(policy)).digest('hex')}`
}

/**
 * Whether `conn` runs on this server's own host: it arrived on the local
 * socket. Browser-callback sign-ins that finish on a loopback listener here
 * can only finish for such a connection. Sent as `studio_welcome.onHost`.
 */
export function connectionOnHost(conn: Pick<Connection, 'transport'>): boolean {
  return conn.transport === 'local'
}

/** Static server-side capability set advertised on every `studio_welcome`. */
export const SERVER_CAPABILITIES: readonly string[] = ['graph', 'browser', 'terminal', PORT_FORWARD_CAPABILITY]

export interface HelloDeps {
  authPolicy: AuthPolicy
  /** The paired-client registry, consulted only for a relay-fed connection's pre-verified `paired` credential. */
  credentials?: CredentialsStore
  registry: ConnectionRegistry
  environmentId: string
  label: string
  serverVersion: string
  engineVersion: () => string
  buildSnapshot: (principal: StudioPrincipalSummary, view: StudioView) => StudioSnapshot
  /**
   * The policy for the principal being welcomed. Waits for the server's first
   * policy read, so a welcome never carries a policy that is merely not loaded yet.
   */
  getEnterprisePolicy: (principal: StudioPrincipalSummary, claims?: Record<string, unknown>) => EnterprisePolicy | null | Promise<EnterprisePolicy | null>
  /** The relays a paired client is told about on every welcome. Absent: none are told. */
  advertisedRelays?: () => EnvironmentRelay[]
  /** The LAN addresses this server answers on. See `studio_welcome.directAddresses`. */
  directAddresses?: () => string[]
  /**
   * Whether a `paired` credential is admitted over TCP without sealed frames
   * (`server.json` `listen.tcp.allowUnsealedPaired`). Absent means no: the
   * secure answer is the default, and only the real listener reads config.
   */
  allowUnsealedPaired?: () => boolean
}

/**
 * Process one `studio_hello`. Sends exactly one reply frame (`studio_welcome`
 * or `studio_refused`) and, on success, registers the connection and returns
 * `true` so the caller wires event subscription. Never throws — an
 * unexpected `authenticate()` rejection is treated as `unauthorized`.
 */
export function handleHello(conn: Connection, hello: Extract<StudioFrame, { type: 'studio_hello' }>, deps: HelloDeps): Promise<boolean> {
  // One `hello.auth` span from the hello's receipt to its welcome or refusal.
  return withSpan('hello.auth', {
    kind: 'server',
    attrs: { connection_id: conn.id, client_kind: hello.clientKind, credential_kind: hello.credential.kind, transport: conn.transport },
  }, (_span, ctx) => helloNow(conn, hello, deps).then((welcomed) => {
    ctx.annotate({ accepted: welcomed, ...(conn.principal ? { user: conn.principal.subject } : {}) })
    return welcomed
  }))
}

async function helloNow(conn: Connection, hello: Extract<StudioFrame, { type: 'studio_hello' }>, deps: HelloDeps): Promise<boolean> {
  log('hello received', {
    connection_id: conn.id,
    client_id: hello.clientId,
    client_kind: hello.clientKind,
    protocol_version: hello.protocolVersion,
    credential_kind: hello.credential.kind,
    transport: conn.transport,
  })

  if (!isSupportedProtocolVersion(hello.protocolVersion)) {
    log('hello refused: protocol version outside accepted window', {
      connection_id: conn.id,
      client_id: hello.clientId,
      client_protocol_version: hello.protocolVersion,
      required_protocol_version: PROTOCOL_VERSION,
    })
    conn.send({
      type: 'studio_refused',
      reason: 'protocol_version',
      detail: `client protocolVersion ${hello.protocolVersion} is outside the accepted window`,
      requiredProtocolVersion: PROTOCOL_VERSION,
    })
    return false
  }

  // A paired client on the TCP listener must seal its frames. The listener is
  // plain `ws://`, so the HMAC proof alone authenticates the client and then
  // leaves the whole session readable on the LAN.
  if (hello.credential.kind === 'paired' && conn.transport === 'tcp') {
    if (!conn.sealedClientId && !(deps.allowUnsealedPaired?.() ?? false)) {
      log('hello refused: paired client did not seal its frames', { connection_id: conn.id, client_id: hello.credential.clientId, reason: 'unsealed_paired' })
      conn.send({ type: 'studio_refused', reason: 'unauthorized', detail: 'this server requires sealed frames from a paired client; update the client' })
      return false
    }
    if (conn.sealedClientId && hello.credential.clientId !== conn.sealedClientId) {
      warn('hello refused: sealed socket belongs to a different clientId', { connection_id: conn.id, presented_client_id: hello.credential.clientId, sealed_client_id: conn.sealedClientId })
      conn.send({ type: 'studio_refused', reason: 'unauthorized' })
      return false
    }
  }

  let auth: AuthResult
  try {
    if (conn.preVerifiedClientId && hello.credential.kind === 'paired' && deps.credentials) {
      // A relay-fed connection: the E2E secret that opened the hello is the
      // proof, and it belongs to exactly one clientId. A hello naming any
      // other clientId on this channel is refused outright.
      if (hello.credential.clientId !== conn.preVerifiedClientId) {
        warn('hello refused: relay channel belongs to a different clientId', { connection_id: conn.id, presented_client_id: hello.credential.clientId, channel_client_id: conn.preVerifiedClientId })
        auth = { ok: false, reason: 'unauthorized' }
      } else {
        auth = await acceptPreVerifiedPaired(hello.credential.clientId, deps.credentials)
      }
    } else {
      auth = await deps.authPolicy.authenticate(hello.credential, conn.transport, conn.sessionCookie)
    }
  } catch (err) {
    warn('authPolicy.authenticate threw; treating as unauthorized', { connection_id: conn.id, error: String(err) })
    auth = { ok: false }
  }
  if (!auth.ok) {
    log('hello refused: unauthorized', { connection_id: conn.id, client_id: hello.clientId, credential_kind: hello.credential.kind, reason: auth.reason ?? 'unauthorized' })
    conn.send({ type: 'studio_refused', reason: 'unauthorized' })
    return false
  }

  /*
   * Reconnect displaces this client's own previous connection.
   *
   * Deliberately AFTER authentication, and only when the existing connection
   * resolved to the SAME subject: an unauthenticated caller must never be
   * able to evict a live client by guessing its clientId, so a clientId
   * collision across subjects is still refused.
   *
   * Refusing a client its own identity -- which is what this check used to do
   * unconditionally -- makes a reload, a second tab, or any reconnect after a
   * dropped socket permanently fail, because nothing removes the stale entry.
   * The client then retries forever while the server keeps writing events
   * into a socket nobody reads.
   */
  const existing = deps.registry.findByClientId(hello.clientId)
  if (existing) {
    if (existing.principal?.subject !== auth.principal.subject) {
      log('hello refused: clientId already connected for a different subject', {
        connection_id: conn.id,
        client_id: hello.clientId,
        existing_connection_id: existing.id,
      })
      conn.send({ type: 'studio_refused', reason: 'duplicate_client', detail: `clientId ${hello.clientId} is already connected` })
      return false
    }
    log('displacing this client\'s previous connection', {
      connection_id: conn.id,
      client_id: hello.clientId,
      displaced_connection_id: existing.id,
      subject: auth.principal.subject,
    })
    existing.close('displaced', `clientId ${hello.clientId} reconnected as ${conn.id}`)
    deps.registry.remove(existing)
  }

  conn.clientId = hello.clientId
  conn.clientKind = hello.clientKind
  conn.view = hello.view ?? 'mirror'
  conn.pairedClientId = hello.credential.kind === 'paired' ? hello.credential.clientId : null
  conn.capabilities = hello.capabilities
  conn.protocolVersion = hello.protocolVersion
  conn.principal = auth.principal
  conn.scopes = auth.scopes
  conn.authExpiresAt = auth.expiresAt ?? null
  registerPrincipal(auth.principal, auth.claims)

  const enterprisePolicy = await deps.getEnterprisePolicy(auth.principal, auth.claims)
  conn.developerSurfaces = computeDeveloperSurfaces(conn, enterprisePolicy)
  conn.policyHash = enterprisePolicyHash(enterprisePolicy)
  const snapshot = projectSnapshotForSurfaces(deps.buildSnapshot(auth.principal, conn.view), conn.developerSurfaces)

  conn.send({
    type: 'studio_welcome',
    protocolVersion: PROTOCOL_VERSION,
    environmentId: deps.environmentId,
    label: deps.label,
    platform: process.platform,
    serverVersion: deps.serverVersion,
    engineVersion: deps.engineVersion(),
    capabilities: [...SERVER_CAPABILITIES],
    principal: auth.principal,
    scopes: auth.scopes,
    ...(hello.credential.kind === 'paired'
      ? {
          pairedClientId: hello.credential.clientId,
          relays: deps.advertisedRelays?.() ?? [],
          directAddresses: deps.directAddresses?.() ?? [],
        }
      : {}),
    enterprisePolicy,
    settingsHiddenGroups: computeSettingsHiddenGroups(conn, enterprisePolicy),
    developerSurfaces: conn.developerSurfaces,
    policyHash: conn.policyHash,
    onHost: connectionOnHost(conn),
    snapshot,
  })
  deps.registry.add(conn)
  registerPresence(conn)
  log('hello accepted; welcome sent', {
    connection_id: conn.id,
    client_id: hello.clientId,
    subject: auth.principal.subject,
    scope_count: auth.scopes.length,
    client_kind: hello.clientKind,
    view: conn.view,
    on_host: connectionOnHost(conn),
  })
  return true
}
