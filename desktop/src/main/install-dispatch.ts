import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { log as _log, error as _error } from './logger'

function log(message: string, fields?: Record<string, unknown>): void {
  _log('updater', message, fields)
}

function error(message: string, fields?: Record<string, unknown>): void {
  _error('updater', message, fields)
}

const execFileAsync = promisify(execFile)

/**
 * The installed app bundle's root directory, resolved from the running
 * executable's path. darwin-only: an Ion.app bundle's executable always
 * lives three levels below the bundle root
 * (Ion.app/Contents/MacOS/Ion), which is what the ditto-based install
 * worker needs to know what to replace. Windows has no equivalent bundle
 * concept — NSIS/electron-updater handle the install path themselves.
 */
export function installedAppPath(executablePath = process.execPath): string {
  // /Applications/Ion.app/Contents/MacOS/Ion → /Applications/Ion.app.
  return dirname(dirname(dirname(executablePath)))
}

/** Stage a signed update archive and dispatch the detached bundle installer (darwin). */
async function dispatchMacInstall(downloadedZip: string): Promise<number> {
  if (!existsSync(downloadedZip)) {
    throw new Error('downloaded update archive is missing')
  }

  const stagingDir = mkdtempSync(join(app.getPath('temp'), 'ion-update-'))
  const stagedApp = join(stagingDir, 'Ion.app')
  try {
    await execFileAsync('ditto', ['-x', '-k', downloadedZip, stagingDir])
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true })
    error('updater: update archive extraction failed', { error: String(err), archive: downloadedZip })
    throw new Error('could not prepare the downloaded update')
  }
  if (!existsSync(stagedApp)) {
    rmSync(stagingDir, { recursive: true, force: true })
    throw new Error('downloaded update does not contain Ion.app')
  }

  const worker = join(process.resourcesPath, 'install-worker.sh')
  if (!existsSync(worker)) {
    rmSync(stagingDir, { recursive: true, force: true })
    throw new Error('install worker is missing from this Ion build')
  }

  const child = spawn(worker, [stagedApp, installedAppPath(), String(process.pid), 'true'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  if (!child.pid) {
    rmSync(stagingDir, { recursive: true, force: true })
    throw new Error('could not start the update installer')
  }
  log('updater: detached install worker dispatched', {
    worker_pid: child.pid,
    staged_app: stagedApp,
    archive: downloadedZip,
  })
  return child.pid
}

/**
 * Dispatches the platform-appropriate update install. darwin extracts the
 * downloaded zip and hands off to the detached bundle-swap worker (above);
 * win32 hands the downloaded NSIS installer to electron-updater's own
 * quitAndInstall, which the desktop's electron-builder NSIS target already
 * knows how to run silently over the current install.
 */
export async function dispatchUpdateInstall(downloadedArchive: string): Promise<number> {
  if (process.platform === 'darwin') return dispatchMacInstall(downloadedArchive)
  if (process.platform === 'win32') {
    log('updater: windows install via electron-updater quitAndInstall')
    autoUpdater.quitAndInstall(false, true)
    return process.pid
  }
  throw new Error(`update install is not supported on ${process.platform}`)
}
