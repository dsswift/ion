/**
 * The command modifier key for the current platform: Cmd on macOS, Ctrl
 * everywhere else. Manifest contract C8 (windows-mvp program).
 *
 * Detection prefers `host.shell.platform` on a host with an operating-system
 * shell (the Electron preload's `process.platform`, authoritative). The
 * `navigator.platform` regex is what a browser Studio client uses: its
 * shell reports a placeholder platform, and the machine in front of the
 * user is what decides the modifier key.
 */
import { host } from '../host/host-instance'

function isMac(): boolean {
  // Evaluated at import time (IS_MAC is a module constant), so a partial
  // host double that omits `capabilities` must read as "no native shell"
  // rather than throw out of every module that imports a keyboard helper.
  const caps: unknown = typeof host.capabilities === 'function' ? host.capabilities() : undefined
  if (Array.isArray(caps) && caps.includes('nativeShell')) return host.shell.platform === 'darwin'
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)
}

export const IS_MAC = isMac()

/** True when the platform's command modifier is held on e. */
export function isModKey(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey
}

/** Alias for a keyboard event; same predicate, named for call-site clarity. */
export function isModHeld(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isModKey(e)
}

/** The glyph/label for the command modifier, for UI hints. */
export const MOD_KEY_LABEL = IS_MAC ? '⌘' : 'Ctrl'
