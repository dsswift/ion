/**
 * `paired` credential verification (manifest requirement: "clientId + HMAC-
 * SHA256 proof over a server nonce ... secret from credentials.json via the
 * secret store; revoked -> credential_revoked").
 *
 * Reuses `remote/crypto.ts`'s `verifyAuthProof` (the same HMAC-SHA256 primitive
 * the desktop<->iOS LAN pairing challenge already uses) rather than
 * reimplementing HMAC verification a second time.
 */
import { verifyAuthProof } from '../remote/crypto'
import { candidateNonces } from './nonce'
import type { CredentialsStore } from './credentials-store'
import type { AuthResult } from '../protocol/hello'
import { isSharedTenancy } from '../config/current'
import { resolveLocalConnectionPrincipal } from '../identity/local-principal'
import { isDeviceSubject } from '../identity/paired-subject'
import { lookupPrincipal } from '../identity/principal-registry'
import type { StudioPrincipalSummary } from '@ion/shared/studio-wire/types'
import type { CredentialClientRecord } from './credentials-store'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('auth-paired', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('auth-paired', msg, fields)
}

/**
 * The principal a stored pairing acts as. On a shared-tenancy install every
 * device is the install owner's -- ALWAYS the host identity, regardless of
 * what the stored record's subject already is. This must not be gated on
 * `isDeviceSubject(record.subject)`: `resolvePairedSubject` already writes
 * `record.subject` as the host subject (`local:<username>`) for a device
 * paired under shared tenancy, and the boot migration
 * (`identity/host-identity-migration.ts`) rewrites any record paired before
 * host identity existed the same way -- so by the time `pairedPrincipal` runs,
 * a device-shaped subject is the rare case, not the common one. Gating the
 * fold on it meant a record whose subject was ALREADY `local:<username>`
 * fell through to `record.label` (the device's own pairing nickname, e.g.
 * "iPhone") as its displayName instead of the host's -- silently
 * reintroducing a second, device-scoped identity for the same person on
 * every subsequent login, overwriting the shared `local:<username>` entry in
 * `principal-registry.ts` (last-authenticated-device wins) and corrupting
 * every other session that resolves its principal from that registry.
 */
export async function pairedPrincipal(record: Pick<CredentialClientRecord, 'subject' | 'label' | 'clientId'>): Promise<StudioPrincipalSummary> {
  if (isSharedTenancy()) {
    // Same precedence as the host's own local connection (hello.ts's
    // LocalOnlyAuthPolicy): the signed-in Entra identity when one exists,
    // else the OS username. A paired phone and the desktop it is paired to
    // are the same person on two devices -- both must fold to the same
    // canonical value, not one to Entra and the other to the OS username.
    const host = await resolveLocalConnectionPrincipal()
    log('shared-tenancy install: acts as the host identity', { client_id: record.clientId, stored_subject: record.subject, device_shaped: isDeviceSubject(record.subject), subject: host.subject })
    return { subject: host.subject, displayName: host.displayName ?? host.subject, provider: host.provider, kind: host.kind, username: host.username }
  }
  // A device paired as a person an identity provider signed in (a bearer's
  // `sub`, from `auth.createOwnPairingLink`) is that person on another
  // device: it carries their identity, so its sessions keep their username
  // and email and its login does not overwrite them with a device label.
  const known = lookupPrincipal(record.subject)
  if (known?.kind === 'operator') {
    log('isolated install: acts as the signed-in person the pairing names', { client_id: record.clientId, subject: known.subject, provider: known.provider ?? '' })
    return { ...known }
  }
  return { subject: record.subject, displayName: record.label ?? record.subject }
}

export interface PairedCredential {
  kind: 'paired'
  clientId: string
  proof: string
}

/**
 * Verifies a `paired` credential against `store`. Tries the proof against
 * every currently-valid nonce (current + previous -- see `nonce.ts`) so a
 * proof computed just before a rotation still verifies.
 */
export async function verifyPaired(credential: PairedCredential, store: CredentialsStore): Promise<AuthResult> {
  const record = store.get(credential.clientId)
  if (!record) {
    warn('paired auth refused: unknown clientId', { client_id: credential.clientId, reason: 'unauthorized' })
    return { ok: false, reason: 'unauthorized' }
  }
  if (record.revokedAt !== null) {
    log('paired auth refused: credential_revoked', { client_id: credential.clientId, subject: record.subject, reason: 'credential_revoked' })
    return { ok: false, reason: 'credential_revoked' }
  }

  const secret = store.secretFor(credential.clientId)
  if (!secret) {
    warn('paired auth refused: stored secret is undecodable', { client_id: credential.clientId, reason: 'unauthorized' })
    return { ok: false, reason: 'unauthorized' }
  }

  const matched = candidateNonces().some((nonce) => verifyAuthProof(nonce, credential.proof, secret))
  if (!matched) {
    log('paired auth refused: unauthorized (proof mismatch)', { client_id: credential.clientId, reason: 'unauthorized' })
    return { ok: false, reason: 'unauthorized' }
  }

  store.touch(credential.clientId)
  const principal = await pairedPrincipal(record)
  log('paired auth accepted', { client_id: credential.clientId, subject: principal.subject, scope_count: record.scopes.length })
  return { ok: true, principal, scopes: record.scopes }
}

/**
 * Admits a `paired` credential whose proof is the E2E channel itself: every
 * envelope on a relay-fed connection was sealed with this client's pairing
 * secret, and nobody else holds it. No nonce exists over a relay to HMAC
 * against, so the record checks (known, not revoked) are the whole gate.
 * `relay-listener.ts` marks the connection; `hello.ts` calls this only when
 * the presented clientId matches that mark.
 */
export async function acceptPreVerifiedPaired(clientId: string, store: CredentialsStore): Promise<AuthResult> {
  const record = store.get(clientId)
  if (!record) {
    warn('relay paired auth refused: unknown clientId', { client_id: clientId, reason: 'unauthorized' })
    return { ok: false, reason: 'unauthorized' }
  }
  if (record.revokedAt !== null) {
    log('relay paired auth refused: credential_revoked', { client_id: clientId, subject: record.subject, reason: 'credential_revoked' })
    return { ok: false, reason: 'credential_revoked' }
  }
  store.touch(clientId)
  const principal = await pairedPrincipal(record)
  log('relay paired auth accepted (channel secret is the proof)', { client_id: clientId, subject: principal.subject, scope_count: record.scopes.length })
  return { ok: true, principal, scopes: record.scopes }
}
