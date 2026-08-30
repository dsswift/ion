import { app, clipboard, ipcMain, nativeImage } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { IPC } from '../../shared/types'
import { LOG_FILE, log as _log, warn as _warn, debug as _debug } from '../logger'
import { state, sessionPlane } from '../state'
import { broadcast } from '../broadcast'
import { gitExec } from '../git-runner'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('main', msg, fields)
}

/**
 * Size ceiling for a clipboard image, in bytes.
 *
 * A chart canvas at retina scale is well under a megabyte; 20 MiB is a
 * generous bound whose purpose is to refuse a malformed or hostile payload
 * before it is decoded, not to constrain legitimate charts.
 */
const MAX_CLIPBOARD_PNG_BYTES = 20 * 1024 * 1024

/** PNG magic number. A payload that does not start with it is not a PNG. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CHART_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
const MESSAGE_ID_PATTERN = /^[a-zA-Z0-9_:.-]{1,128}$/

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
    } catch (err) {
      // Font enumeration failed; fall back to a safe default set, but log so
      // the fallback (and any AppleScript failure) is visible.
      debug('system: font enumeration failed; using defaults', { error: String(err) })
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
      } catch (err) {
        // The diagnostics endpoint silently omitting logs when it can't read
        // them is especially bad; log the read failure.
        warn('system: diagnostics recent-log read failed', { error: String(err) })
      }
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

  /**
   * Copy PNG bytes to the OS clipboard.
   *
   * Every rejection is explicit and logged. The renderer supplies bytes it
   * produced from a canvas, so this is an untrusted-input boundary like any
   * other IPC entry point: type, size, signature, and decodability are each
   * checked before `writeImage`, because a silently-empty clipboard is a
   * failure the user discovers only when they paste.
   */
  ipcMain.handle(IPC.COPY_PNG_TO_CLIPBOARD, (_event, png: unknown): boolean => {
    if (!(png instanceof ArrayBuffer)) {
      warn('system: clipboard png rejected — not an ArrayBuffer', { type: typeof png })
      return false
    }
    if (png.byteLength === 0 || png.byteLength > MAX_CLIPBOARD_PNG_BYTES) {
      warn('system: clipboard png rejected — size out of range', { bytes: png.byteLength })
      return false
    }
    const bytes = Buffer.from(png)
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      warn('system: clipboard png rejected — bad signature', { bytes: bytes.length })
      return false
    }
    const image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) {
      // A well-formed header with an undecodable body would otherwise clear
      // the clipboard and report success.
      warn('system: clipboard png rejected — decoded to an empty image', { bytes: bytes.length })
      return false
    }
    clipboard.writeImage(image)
    const size = image.getSize()
    log('system: png copied to clipboard', { bytes: bytes.length, width: size.width, height: size.height })
    return true
  })

  /**
   * Route a chart-jump request to the conversation renderers.
   *
   * Broadcast rather than returned: the requester (attachments panel, moved
   * marker) and the target (the transcript's virtualizer) are separate
   * components that can live in different windows under the Studio mirror, so
   * the transcript listens for the request wherever it is mounted.
   */
  ipcMain.on(IPC.CHART_JUMP, (_event, payload: unknown) => {
    const request = payload as { tabId?: unknown; chartId?: unknown; messageId?: unknown } | null
    const tabId = typeof request?.tabId === 'string' ? request.tabId : ''
    const chartId = typeof request?.chartId === 'string' ? request.chartId : ''
    const messageId = typeof request?.messageId === 'string' ? request.messageId : ''
    if (!tabId || !CHART_ID_PATTERN.test(chartId) || !MESSAGE_ID_PATTERN.test(messageId)) {
      warn('system: chart jump refused — malformed request', {
        tab_id: tabId, chart_id: chartId, message_id: messageId,
      })
      return
    }
    broadcast(IPC.CHART_JUMP, { tabId, chartId, messageId })
    log('system: chart jump routed', { tab_id: tabId, chart_id: chartId, message_id: messageId })
  })

}
