/**
 * paired-device-migration -- a phone paired on the `desktop_*` wire becomes a
 * `credentials.json` client, so it can authenticate on the Studio wire with
 * the secret it already holds. No re-pair.
 *
 * The two records are the same pairing seen from two stores. Both derive
 * their id from the shared secret (`deriveChannelId(secret).slice(0, 16)`),
 * so `clientId` is the device's `id` and the phone's stored secret produces a
 * valid `paired` proof against the migrated record.
 *
 * The migrated client acts as the install's own identity (`hostSubject()`).
 * That is what a phone on the `desktop_*` wire has always acted as: that wire
 * has no per-device principal, so giving a migrated phone a device-shaped
 * subject would hide every conversation it could see yesterday.
 *
 * Copy, not move: `settings.pairedDevices` is left alone. It is still read --
 * `remote/paired-device-lookup.ts` resolves a principal from it for presence
 * attribution and the relay listener -- and leaving it means an install that
 * has not yet booted this server is never stranded. Runs on every boot and
 * writes only what is missing, so nothing is duplicated and nothing is lost.
 */
import type { Scope } from '@ion/shared/studio-wire/types'
import { isRelayIdentity, type RelayIdentity } from '@ion/shared/studio-wire/relay-envelope'
import { readSettings } from '../persistence/settings-store'
import { decodeSharedSecret } from '../remote/device-secret'
import { hostSubject } from '../identity/paired-subject'
import type { PairedDevice } from '../remote/protocol'
import type { CredentialsStore } from './credentials-store'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('paired-device-migration', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('paired-device-migration', msg, fields)
}

/** What a phone can do on the `desktop_*` wire today: everything but administer the host. */
export const MIGRATED_PHONE_SCOPES: readonly Scope[] = ['conversations:read', 'conversations:operate', 'git:write', 'terminal:operate']

export interface PairedDeviceMigrationResult {
  migrated: string[]
  /** Device id to the reason it was skipped. */
  skipped: Record<string, string>
}

/** The identity the phone reported for an OIDC relay, when both halves are known. */
function relayIdentityOf(device: PairedDevice, issuer: unknown): RelayIdentity | undefined {
  const identity = { issuer, subject: device.relayOidcSubject }
  return isRelayIdentity(identity) ? identity : undefined
}

export function migratePairedDevices(store: CredentialsStore): PairedDeviceMigrationResult {
  const result: PairedDeviceMigrationResult = { migrated: [], skipped: {} }
  let settings: Record<string, unknown>
  try {
    settings = readSettings() as Record<string, unknown>
  } catch (err) {
    warn('settings unreadable; no paired device migrated', { error: String(err) })
    return result
  }
  const devices = Array.isArray(settings.pairedDevices) ? (settings.pairedDevices as PairedDevice[]) : []
  if (devices.length === 0) {
    log('no paired devices to migrate')
    return result
  }
  const subject = hostSubject()
  for (const device of devices) {
    const id = typeof device?.id === 'string' ? device.id : ''
    if (!id) {
      result.skipped['(no id)'] = 'record has no id'
      warn('paired device skipped: record has no id')
      continue
    }
    if (store.get(id)) {
      // Present already, revoked or not: a revoked client must stay revoked.
      result.skipped[id] = 'already a credentials client'
      continue
    }
    const decoded = decodeSharedSecret(device.sharedSecret)
    if (!decoded.ok) {
      result.skipped[id] = `secret undecodable: ${decoded.reason}`
      warn('paired device skipped: stored secret is undecodable; the phone must pair again', { device_id: id, reason: decoded.reason })
      continue
    }
    store.add({
      clientId: id,
      secret: decoded.secret,
      scopes: [...MIGRATED_PHONE_SCOPES],
      subject,
      kind: 'mobile',
      label: device.customName || device.name,
      deviceId: device.mobileDeviceId,
      relayIdentity: relayIdentityOf(device, settings.relayOidcIssuer),
    })
    result.migrated.push(id)
    log('paired device migrated to a credentials client', { device_id: id, subject, has_mobile_device_id: !!device.mobileDeviceId })
  }
  log('paired device migration finished', { device_count: devices.length, migrated_count: result.migrated.length, skipped_count: Object.keys(result.skipped).length })
  return result
}
