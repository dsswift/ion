/**
 * machine-identity.ts — resolves stable hardware and MDM identity for this
 * machine, stamped on every desktop log line.
 *
 * host:        os.hostname() — always present, reflects the machine Electron
 *              is running on (not the Alloy collector).
 * machine_id:  IOPlatformUUID on macOS, MachineGuid on Windows, empty
 *              elsewhere.
 * mdm_device_id / mdm_serial: from /Library/Managed Preferences/com.ion.engine.plist
 *              on macOS, or the MDMDeviceID / MDMSerialNumber registry values
 *              under HKLM\SOFTWARE\Policies\IonEngine on Windows (the same
 *              two names the engine reserves as non-config metadata,
 *              manifest contract C5), when the machine is enrolled in MDM
 *              (e.g. Intune). Absent otherwise.
 */
import { hostname } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { log as _log, debug as _debug, warn as _warn } from './logger'

const execFileAsync = promisify(execFile)

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('machine_identity', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('machine_identity', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('machine_identity', msg, fields)
}

export interface MachineIdentity {
  host: string
  machineId: string
  mdmDeviceId: string
  mdmSerial: string
}

let cached: MachineIdentity | null = null

async function readIoreg(): Promise<{ machineId: string; serial: string }> {
  try {
    const { stdout } = await execFileAsync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
      timeout: 5000,
    })
    const uuidMatch = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
    const serialMatch = stdout.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/)
    return {
      machineId: uuidMatch?.[1]?.trim() ?? '',
      serial: serialMatch?.[1]?.trim() ?? '',
    }
  } catch (err) {
    log('ioreg read failed', { error: String(err) })
    return { machineId: '', serial: '' }
  }
}

async function readMdmPlist(): Promise<{ mdmDeviceId: string; mdmSerial: string }> {
  const plistPath = '/Library/Managed Preferences/com.ion.engine.plist'
  try {
    const { stdout } = await execFileAsync('plutil', ['-convert', 'json', plistPath, '-o', '-'], {
      timeout: 5000,
    })
    const obj = JSON.parse(stdout) as Record<string, unknown>
    return {
      mdmDeviceId: typeof obj['MDMDeviceID'] === 'string' ? (obj['MDMDeviceID'] as string) : '',
      mdmSerial: typeof obj['MDMSerialNumber'] === 'string' ? (obj['MDMSerialNumber'] as string) : '',
    }
  } catch {
    // Plist missing or not enrolled — not an error condition.
    return { mdmDeviceId: '', mdmSerial: '' }
  }
}

/**
 * Reads one REG_SZ value via `reg query`. warnOnFailure controls whether a
 * miss is logged at WARN (MachineGuid, which should always exist) or DEBUG
 * (the two MDM values, absent on every non-enrolled machine — the normal
 * case).
 */
async function regQuery(key: string, value: string, warnOnFailure: boolean): Promise<string> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', key, '/v', value], { timeout: 5000, windowsHide: true })
    const m = new RegExp(`^\\s*${value}\\s+REG_SZ\\s+(.+?)\\s*$`, 'm').exec(stdout)
    return m?.[1] ?? ''
  } catch (err) {
    if (warnOnFailure) {
      warn('reg query failed', { key, value, error: String(err) })
    } else {
      debug('reg query found nothing (not enrolled)', { key, value })
    }
    return ''
  }
}

async function readWindowsIdentity(): Promise<{ machineId: string; mdmDeviceId: string; mdmSerial: string }> {
  const [machineId, mdmDeviceId, mdmSerial] = await Promise.all([
    regQuery('HKLM\\SOFTWARE\\Microsoft\\Cryptography', 'MachineGuid', true),
    regQuery('HKLM\\SOFTWARE\\Policies\\IonEngine', 'MDMDeviceID', false),
    regQuery('HKLM\\SOFTWARE\\Policies\\IonEngine', 'MDMSerialNumber', false),
  ])
  return { machineId, mdmDeviceId, mdmSerial }
}

/**
 * Load machine identity once. Subsequent calls return the cached result.
 * Non-fatal: errors in subprocess reads return partial identity (host always set).
 */
export async function loadMachineIdentity(): Promise<MachineIdentity> {
  if (cached) return cached

  const host = hostname().replace(/\.local$/, '')

  if (process.platform === 'darwin') {
    const [ioreg, mdm] = await Promise.all([readIoreg(), readMdmPlist()])
    cached = {
      host,
      machineId: ioreg.machineId,
      mdmDeviceId: mdm.mdmDeviceId,
      mdmSerial: mdm.mdmSerial,
    }
  } else if (process.platform === 'win32') {
    const identity = await readWindowsIdentity()
    cached = { host, ...identity }
  } else {
    log('machine identity: platform has no identity source', { platform: process.platform })
    cached = { host, machineId: '', mdmDeviceId: '', mdmSerial: '' }
  }

  log('machine identity loaded', {
    host: cached.host,
    has_machine_id: cached.machineId !== '',
    has_mdm: cached.mdmDeviceId !== '',
  })
  return cached
}

/** Sync accessor — returns null before loadMachineIdentity() resolves. */
export function getMachineIdentity(): MachineIdentity | null {
  return cached
}

/**
 * TEST ONLY. Reset the cached identity so tests get a fresh load.
 * Not for use in shipped code paths.
 */
export function _resetMachineIdentityForTest(): void {
  cached = null
}
