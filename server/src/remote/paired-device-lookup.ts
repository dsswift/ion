/**
 * Standalone paired-device lookup by id, reading directly from settings.
 *
 * `settings.pairedDevices` is the record a phone paired on the retired
 * `desktop_*` wire left behind. `auth/paired-device-migration.ts` copies each
 * one into `credentials.json` at boot and deliberately leaves this key in
 * place, so this lookup still answers for a device migrated from it --
 * presence attribution (`protocol/presence.ts`) and the relay listener
 * resolve a principal by id through here.
 */
import { readSettings } from '../persistence/settings-store'
import { warn as _warn } from '../logger'
import type { PairedDevice } from './protocol'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('remote', msg, fields)
}

export function getPairedDeviceById(deviceId: string): PairedDevice | null {
  try {
    const s = readSettings()
    const devices = Array.isArray(s.pairedDevices) ? (s.pairedDevices as PairedDevice[]) : []
    return devices.find((d) => d.id === deviceId) || null
  } catch (err) {
    warn('paired-device lookup failed', { device_id: deviceId, error: String(err) })
    return null
  }
}
