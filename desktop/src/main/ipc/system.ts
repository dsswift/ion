import { app, ipcMain } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { execFile } from 'child_process'
import { IPC } from '../../shared/types'
import { log as _log, LOG_FILE } from '../logger'
import { state, sessionPlane } from '../state'
import { gitExec } from '../git-runner'

function log(msg: string): void {
  _log('main', msg)
}

export function registerSystemIpc(): void {
  ipcMain.handle(IPC.LIST_FONTS, async () => {
    if (state.cachedFonts) return state.cachedFonts
    try {
      const script = `
use framework "AppKit"
set fm to current application's NSFontManager's sharedFontManager()
set families to fm's availableFontFamilies() as list
set output to ""
repeat with f in families
  set fl to f as text
  if fl contains "Nerd" then
    set output to output & fl & linefeed
  else
    set members to fm's availableMembersOfFontFamily:f
    if members is not missing value and (count of members) > 0 then
      set traits to item 4 of (item 1 of members) as integer
      if (traits div 1024) mod 2 = 1 then
        set output to output & fl & linefeed
      end if
    end if
  end if
end repeat
return output`
      const { stdout } = await gitExec('/usr/bin/osascript', ['-e', script])
      state.cachedFonts = stdout.split('\n').map((s: string) => s.trim()).filter(Boolean).sort((a: string, b: string) => a.localeCompare(b))
      return state.cachedFonts
    } catch {
      return ['Menlo', 'Monaco', 'Courier New']
    }
  })

  ipcMain.handle(IPC.GET_DIAGNOSTICS, () => {
    const health = sessionPlane.getHealth()

    let recentLogs = ''
    if (existsSync(LOG_FILE)) {
      try {
        const content = readFileSync(LOG_FILE, 'utf-8')
        const lines = content.split('\n')
        recentLogs = lines.slice(-100).join('\n')
      } catch {}
    }

    return {
      health,
      logPath: LOG_FILE,
      recentLogs,
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      appVersion: app.getVersion(),
      transport: 'engine',
    }
  })

  ipcMain.handle(IPC.OPEN_IN_VSCODE, (_event, projectPath: string) => {
    const dir = projectPath || process.cwd()

    try {
      execFile('code', ['--reuse-window', dir], (err: Error | null) => {
        if (err) {
          log(`'code' CLI failed, falling back to open -a: ${err.message}`)
          execFile('/usr/bin/open', ['-a', 'Visual Studio Code', dir], (err2: Error | null) => {
            if (err2) log(`Failed to open VS Code: ${err2.message}`)
            else log(`Opened VS Code (via open -a) at: ${dir}`)
          })
        } else {
          log(`Opened VS Code at: ${dir}`)
        }
      })
      return true
    } catch (err: unknown) {
      log(`Failed to open VS Code: ${err}`)
      return false
    }
  })
}
