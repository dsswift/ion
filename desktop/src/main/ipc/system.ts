import { clipboard, ipcMain, nativeImage } from 'electron'
import { IPC } from '@ion/shared/types'
import { log as _log, warn as _warn, debug as _debug } from '../logger'
import { state } from '../state'
import { gitExec } from '@ion/server/git/git-runner'

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

export function registerSystemIpc(): void {
  ipcMain.handle(IPC.LIST_FONTS, async () => {
    if (state.cachedFonts) return state.cachedFonts
    // Enumeration is AppleScript via osascript, which exists only on macOS.
    // Off darwin it throws and lands in the catch below, where the fallback
    // list was three macOS families -- so the Windows font picker offered
    // Menlo, Monaco and Courier New, two of which cannot render there.
    if (process.platform !== 'darwin') {
      state.cachedFonts = fallbackFontFamilies()
      debug('system: font enumeration unavailable off darwin; using platform defaults', {
        platform: process.platform,
        count: state.cachedFonts.length,
      })
      return state.cachedFonts
    }
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
      return fallbackFontFamilies()
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
}

/**
 * Monospace families to offer when the system cannot be enumerated.
 *
 * Every entry must actually exist on the platform it is offered for, or the
 * picker lists a font that silently falls back to something proportional.
 * Windows ships Consolas and Courier New with the OS and Cascadia Code /
 * Cascadia Mono with Windows Terminal; macOS ships Menlo, Monaco and SF Mono.
 */
function fallbackFontFamilies(): string[] {
  if (process.platform === 'win32') {
    return ['Cascadia Code', 'Cascadia Mono', 'Consolas', 'Courier New', 'Lucida Console']
  }
  if (process.platform === 'linux') {
    return ['DejaVu Sans Mono', 'Liberation Mono', 'Ubuntu Mono', 'monospace']
  }
  return ['Menlo', 'Monaco', 'SF Mono', 'Courier New']
}
