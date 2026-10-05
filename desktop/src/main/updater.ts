import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from 'electron-updater'
import { IPC } from '@ion/shared/types-ipc'
import { broadcast } from './broadcast'
import { dispatchUpdateInstall } from './install-dispatch'
import { quitForUpdate } from './app-lifecycle-quit'
import { info, error as logError } from './logger'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
const tag = 'updater'

const updaterLogger = {
  info: (msg: string) => info(tag, msg),
  warn: (msg: string) => info(tag, msg, { level: 'warn' }),
  error: (msg: string) => logError(tag, msg),
  debug: (msg: string) => info(tag, msg, { level: 'debug' }),
}

let intervalId: ReturnType<typeof setInterval> | undefined
let downloadedArchive: string | null = null
let installStaged = false

export interface AutoUpdaterOptions {
  disableAutoUpdate?: boolean
}

function publish(channel: string, payload: Record<string, unknown>): void {
  broadcast(channel, payload)
}

function reportError(message: string, error: unknown): void {
  logError(tag, message, { error: String(error) })
  publish(IPC.UPDATE_ERROR, { message })
}

async function stageInstall(): Promise<void> {
  if (!downloadedArchive) {
    reportError('No downloaded update is ready to install', 'missing downloaded archive')
    return
  }
  if (installStaged) {
    info(tag, 'update install already staged')
    return
  }
  try {
    const workerPid = await dispatchUpdateInstall(downloadedArchive)
    installStaged = true
    publish(IPC.UPDATE_STAGED, { workerPid })
    info(tag, 'update install staged', { worker_pid: workerPid })
  } catch (err) {
    reportError('Ion could not prepare the update', err)
  }
}

export function initAutoUpdater(options: AutoUpdaterOptions = {}): void {
  if (options.disableAutoUpdate) {
    info(tag, 'skipping — auto-update disabled by enterprise policy')
    return
  }
  if (!app.isPackaged) {
    info(tag, 'skipping — not packaged')
    return
  }

  const feedPath = join(process.resourcesPath, 'app-update.yml')
  if (!existsSync(feedPath)) {
    info(tag, 'skipping — no update feed (local build)')
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = updaterLogger

  autoUpdater.on('update-available', (updateInfo: UpdateInfo) => {
    info(tag, 'update available', { version: updateInfo.version })
  })
  autoUpdater.on('update-not-available', (updateInfo: UpdateInfo) => {
    info(tag, 'update not available', { version: updateInfo.version })
    publish(IPC.UPDATE_PROGRESS, { percent: 0, status: 'not_available' })
  })
  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    publish(IPC.UPDATE_PROGRESS, { percent: progress.percent, status: 'downloading' })
    info(tag, 'update download progress', { percent: progress.percent, transferred: progress.transferred, total: progress.total })
  })
  autoUpdater.on('update-downloaded', (update: UpdateDownloadedEvent) => {
    downloadedArchive = update.downloadedFile
    installStaged = false
    info(tag, 'update downloaded', { version: update.version, archive: downloadedArchive })
    publish(IPC.UPDATE_DOWNLOADED, { version: update.version })
  })
  autoUpdater.on('error', (err: Error) => reportError('Ion could not download the update', err))

  ipcMain.on(IPC.INSTALL_UPDATE, () => { void stageInstall() })
  ipcMain.on(IPC.RESTART_FOR_UPDATE, () => {
    if (!installStaged) {
      reportError('The update is not ready to restart', 'restart requested before staging')
      return
    }
    void quitForUpdate().catch((err) => reportError('Ion could not restart for the update', err))
  })

  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((err) => reportError('Ion could not check for updates', err))
  }, 10_000)
  intervalId = setInterval(() => {
    void autoUpdater.checkForUpdates().catch((err) => reportError('Ion could not check for updates', err))
  }, CHECK_INTERVAL_MS)
}

/** Whether this build has a release feed to update from. A local build has none. */
export function hasUpdateFeed(): boolean {
  return app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))
}

/**
 * Installs the newest release now and restarts into it: the host install a
 * server asks the desktop that runs it for. Resolves `false` when this build
 * already is the newest release. `onStage` hears each step before it starts.
 */
export async function installLatestReleaseNow(onStage: (stage: 'downloading' | 'installing' | 'restarting') => void): Promise<boolean> {
  onStage('downloading')
  const check = await autoUpdater.checkForUpdates()
  if (!check?.isUpdateAvailable) {
    info(tag, 'host install: already on the newest release', { version: app.getVersion() })
    return false
  }
  const files = await (check.downloadPromise ?? autoUpdater.downloadUpdate())
  const archive = downloadedArchive ?? files[0]
  if (!archive) throw new Error('the release was downloaded but no archive was reported')
  info(tag, 'host install: release downloaded', { version: check.updateInfo.version, archive })
  await installArchiveNow(archive, onStage)
  return true
}

/** Installs a staged update archive now and restarts into it. */
export async function installArchiveNow(archive: string, onStage: (stage: 'installing' | 'restarting') => void): Promise<void> {
  onStage('installing')
  const workerPid = await dispatchUpdateInstall(archive)
  installStaged = true
  info(tag, 'host install: install staged', { worker_pid: workerPid, archive })
  onStage('restarting')
  await quitForUpdate()
}

export function stopAutoUpdater(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = undefined
  }
}
