import { app, globalShortcut, Menu, screen } from 'electron'
import { rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { log as _log, flushLogs } from './logger'
import { state, SPACES_DEBUG, sessionPlane, engineBridge, fileWatchers, bashProcesses } from './state'
import { terminalManager } from './terminal-manager-instance'
import { stopTabSnapshotPolling } from './remote/snapshot-polling'
import { createTray, createWindow, installContentSecurityPolicy, snapshotWindowState, showWindow, toggleWindow } from './window-manager'
import { requestPermissions } from './permissions-preflight'
import { cleanOrphanedWorktrees } from './git-runner'

function log(msg: string): void {
  _log('main', msg)
}

export function setupAppLifecycle(): void {
  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock) {
      app.dock.hide()
    }

    await requestPermissions()

    installContentSecurityPolicy()

    cleanOrphanedWorktrees().catch((err: Error) => log(`Worktree cleanup failed: ${err.message}`))

    createWindow()
    snapshotWindowState('after createWindow')

    const pidDir = app.getPath('userData')
    const pidPath = join(pidDir, 'ion.pid')
    writeFileSync(pidPath, String(process.pid))
    log(`PID file written: ${pidPath} (${process.pid})`)

    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
    ]))

    if (SPACES_DEBUG) {
      state.mainWindow?.on('show', () => snapshotWindowState('event window show'))
      state.mainWindow?.on('hide', () => snapshotWindowState('event window hide'))
      state.mainWindow?.on('focus', () => snapshotWindowState('event window focus'))
      state.mainWindow?.on('blur', () => snapshotWindowState('event window blur'))
      state.mainWindow?.webContents.on('focus', () => snapshotWindowState('event webContents focus'))
      state.mainWindow?.webContents.on('blur', () => snapshotWindowState('event webContents blur'))

      app.on('browser-window-focus', () => snapshotWindowState('event app browser-window-focus'))
      app.on('browser-window-blur', () => snapshotWindowState('event app browser-window-blur'))

      screen.on('display-added', (_e, display) => {
        log(`[spaces] event display-added id=${display.id}`)
        snapshotWindowState('event display-added')
      })
      screen.on('display-removed', (_e, display) => {
        log(`[spaces] event display-removed id=${display.id}`)
        snapshotWindowState('event display-removed')
      })
      screen.on('display-metrics-changed', (_e, display, changedMetrics) => {
        log(`[spaces] event display-metrics-changed id=${display.id} changed=${changedMetrics.join(',')}`)
        snapshotWindowState('event display-metrics-changed')
      })
    }

    const registered = globalShortcut.register('Alt+Space', () => toggleWindow('shortcut Alt+Space'))
    if (!registered) {
      log('Alt+Space shortcut registration failed — macOS input sources may claim it')
    }
    globalShortcut.register('CommandOrControl+Shift+K', () => toggleWindow('shortcut Cmd/Ctrl+Shift+K'))

    createTray()

    app.on('activate', () => showWindow('app activate'))
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    sessionPlane.shutdown()
    for (const [, entry] of fileWatchers) {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.watcher.close()
    }
    fileWatchers.clear()
    if (state.tray) {
      state.tray.destroy()
      state.tray = null
    }
    stopTabSnapshotPolling()
    if (state.remoteTransport) {
      state.remoteTransport.stop()
      state.remoteTransport = null
    }
    try { rmSync(join(app.getPath('userData'), 'ion.pid')) } catch {}
    flushLogs()
  })

  process.on('SIGUSR1', () => {
    log('SIGUSR1 received — draining active work before quit')
    const timeout = setTimeout(() => {
      log('Drain timeout (5min) — force quitting')
      state.forceQuit = true
      terminalManager.destroyAll()
      engineBridge.stopAll()
      sessionPlane.shutdown()
      globalShortcut.unregisterAll()
      if (state.tray) { state.tray.destroy(); state.tray = null }
      try { rmSync(join(app.getPath('userData'), 'ion.pid')) } catch {}
      flushLogs()
      app.exit(0)
    }, 5 * 60 * 1000)

    sessionPlane.drain(() => bashProcesses.size > 0).then(() => {
      clearTimeout(timeout)
      log('All agents finished — quitting')
      state.forceQuit = true
      terminalManager.destroyAll()
      engineBridge.stopAll()
      sessionPlane.shutdown()
      globalShortcut.unregisterAll()
      if (state.tray) { state.tray.destroy(); state.tray = null }
      try { rmSync(join(app.getPath('userData'), 'ion.pid')) } catch {}
      flushLogs()
      app.exit(0)
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
