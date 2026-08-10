import { log as _log } from '../../logger'
import { readSettings, writeSettings } from '../../settings-store'
import { broadcast } from '../../broadcast'
import { IPC } from '../../../shared/types'
import type { RemoteCommand } from '../protocol'
import type { PairedDevice } from '../protocol-envelope'
import type { RemotePairedDevice } from '../../../shared/types-session'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function toRendererDevice(d: PairedDevice): RemotePairedDevice {
  return {
    id: d.id,
    name: d.name,
    pairedAt: d.pairedAt,
    lastSeen: d.lastSeen,
    channelId: d.channelId,
    relayOidcAccountUsername: d.relayOidcAccountUsername,
    relayOidcAccountName: d.relayOidcAccountName,
    relayOidcTenantId: d.relayOidcTenantId,
    relayOidcSignedInAt: d.relayOidcSignedInAt,
    relayOidcAccessStatus: d.relayOidcAccessStatus,
    relayOidcAccessReason: d.relayOidcAccessReason,
    relayOidcReportedAt: d.relayOidcReportedAt,
  }
}

export function handleReportMobileAuth(
  cmd: Extract<RemoteCommand, { type: 'desktop_report_mobile_auth' }>,
  deviceId: string,
): void {
  try {
    const settings = readSettings()
    const devices: PairedDevice[] = Array.isArray(settings.pairedDevices) ? settings.pairedDevices : []
    const idx = devices.findIndex((d: any) => d.id === deviceId)
    if (idx < 0) {
      log('report_mobile_auth: unknown device', { device_id: deviceId })
      return
    }
    const device = devices[idx]
    if (cmd.clearIdentity) {
      delete device.relayOidcAccountUsername
      delete device.relayOidcAccountName
      delete device.relayOidcSubject
      delete device.relayOidcTenantId
      delete device.relayOidcSignedInAt
    } else {
      if (cmd.accountUsername !== undefined) device.relayOidcAccountUsername = cmd.accountUsername
      if (cmd.accountName !== undefined) device.relayOidcAccountName = cmd.accountName
      if (cmd.subject !== undefined) device.relayOidcSubject = cmd.subject
      if (cmd.tenantId !== undefined) device.relayOidcTenantId = cmd.tenantId
      if (cmd.signedInAt !== undefined) device.relayOidcSignedInAt = cmd.signedInAt
    }
    if (cmd.accessStatus !== undefined) device.relayOidcAccessStatus = cmd.accessStatus
    if (cmd.accessReason !== undefined) device.relayOidcAccessReason = cmd.accessReason
    if (cmd.reportedAt !== undefined) device.relayOidcReportedAt = cmd.reportedAt
    devices[idx] = device
    settings.pairedDevices = devices
    writeSettings(settings)

    broadcast(IPC.REMOTE_DEVICE_PAIRED, toRendererDevice(device))
    log('report_mobile_auth: persisted', {
      device_id: deviceId,
      has_username: !!cmd.accountUsername,
      has_tenant: !!cmd.tenantId,
    })
  } catch (err) {
    log('report_mobile_auth: failed to persist', { device_id: deviceId, error: (err as Error).message })
  }
}
