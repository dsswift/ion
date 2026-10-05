/**
 * A host install outlives the server it replaces. When one starts, this
 * server leaves a marker in its data directory; the server that boots
 * afterwards finds it and says the install is over, with the version it now
 * runs. That is how a server tells its clients and its Fleet Hubs, on its
 * own, that it came back.
 */
import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { HOST_INSTALL_STALE_MS, type HostInstallRequest } from '@ion/shared/host-install'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { dataDir } from '../paths'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'environment.host-install-marker'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

const FILE = 'host-install-pending.json'

export interface HostInstallMarker {
  kind: HostInstallRequest['kind']
  /** Unix ms the install started. */
  at: number
}

function markerPath(): string {
  return join(dataDir(), FILE)
}

/** Notes that an install is under way on this host. */
export function writeHostInstallMarker(kind: HostInstallRequest['kind'], now: number = Date.now()): void {
  try {
    atomicWriteFileSync(markerPath(), JSON.stringify({ kind, at: now } satisfies HostInstallMarker), 0o600)
    log('host install marker written', { kind })
  } catch (err) {
    warn('host install marker could not be written', { kind, error: String(err) })
  }
}

/** The install under way on this host, or null. A marker too old to be a live install is dropped. */
export function readHostInstallMarker(now: number = Date.now()): HostInstallMarker | null {
  const path = markerPath()
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<HostInstallMarker>
    if ((raw.kind !== 'restart' && raw.kind !== 'release' && raw.kind !== 'artifact') || typeof raw.at !== 'number') throw new Error('not a marker')
    if (now - raw.at > HOST_INSTALL_STALE_MS) {
      warn('host install marker is stale; dropped', { kind: raw.kind, age_ms: now - raw.at })
      clearHostInstallMarker()
      return null
    }
    return { kind: raw.kind, at: raw.at }
  } catch (err) {
    warn('host install marker unreadable; dropped', { error: String(err) })
    clearHostInstallMarker()
    return null
  }
}

export function clearHostInstallMarker(): void {
  try {
    rmSync(markerPath(), { force: true })
  } catch (err) {
    warn('host install marker could not be removed', { error: String(err) })
  }
}
