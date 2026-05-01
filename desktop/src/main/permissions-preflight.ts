import { systemPreferences } from 'electron'
import { readdirSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'
import { log as _log } from './logger'

function log(msg: string): void {
  _log('main', msg)
}

export async function requestPermissions(): Promise<void> {
  if (process.platform !== 'darwin') return

  try {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone')
    if (micStatus === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone')
    }
  } catch (err: any) {
    log(`Permission preflight: microphone check failed — ${err.message}`)
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
      log(`Permission preflight: ${basename(dir)} access OK`)
    } catch (err: any) {
      log(`Permission preflight: ${basename(dir)} access failed — ${err.message}`)
    }
  }
}
