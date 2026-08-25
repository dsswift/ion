import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { log as _log, error as _error } from './logger'

function log(message: string, fields?: Record<string, unknown>): void {
  _log('updater', message, fields)
}

function error(message: string, fields?: Record<string, unknown>): void {
  _error('updater', message, fields)
}

const execFileAsync = promisify(execFile)

export function installedAppPath(executablePath = process.execPath): string {
  // /Applications/Ion.app/Contents/MacOS/Ion → /Applications/Ion.app.
  return dirname(dirname(dirname(executablePath)))
}

/** Stage a signed update archive and dispatch the detached bundle installer. */
export async function dispatchUpdateInstall(downloadedZip: string): Promise<number> {
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
