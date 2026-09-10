/**
 * The command modifier key for the current platform: Cmd on macOS, Ctrl
 * everywhere else. Manifest contract C8 (windows-mvp program).
 *
 * Detection prefers `window.ion.platform` (the Electron preload's
 * `process.platform`, authoritative and available in every real render).
 * The `navigator.platform` regex is the fallback for a bridge-less
 * environment (jsdom in tests, or any future non-Electron host).
 */

function isMac(): boolean {
  const bridgePlatform = typeof window !== 'undefined' ? window.ion?.platform : undefined
  if (bridgePlatform != null) return bridgePlatform === 'darwin'
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
