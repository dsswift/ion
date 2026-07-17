import { systemPreferences } from 'electron'
import { readdirSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'
import { log as _log } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

export async function requestPermissions(): Promise<void> {
  if (process.platform !== 'darwin') return

  try {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone')
    if (micStatus === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone')
    }
  } catch (err: any) {
    log('permissions_preflight: microphone check failed', { error: err.message })
  }

  const home = homedir()
  const tccProtectedDirs = [
    join(home, 'Desktop'),
    join(home, 'Documents'),
    join(home, 'Downloads'),
  ]
  for (const dir of tccProtectedDirs) {
    try {
      readdirSync(dir, { withFileTypes: false })
      log('permissions_preflight: access ok', { dir: basename(dir) })
    } catch (err: any) {
      log('permissions_preflight: access failed', { dir: basename(dir), error: err.message })
    }
  }
}
