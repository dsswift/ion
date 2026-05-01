import { existsSync } from 'fs'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { SETTINGS_FILE, readSettings, writeSettings } from '../settings-store'
import { broadcast } from '../broadcast'

function log(msg: string): void {
  _log('main', msg)
}

export function revokeDeviceLocally(deviceId: string): void {
  log(`[Remote] revoking device locally: ${deviceId}`)
  try {
    if (existsSync(SETTINGS_FILE)) {
      const settings = readSettings()
      const devices = Array.isArray(settings.pairedDevices) ? settings.pairedDevices : []
      settings.pairedDevices = devices.filter((d: any) => d.id !== deviceId)
      writeSettings(settings)
    }
  } catch (err) {
    log(`[Remote] failed to remove device from settings: ${(err as Error).message}`)
  }
  broadcast(IPC.REMOTE_DEVICE_REVOKED, deviceId)
}
