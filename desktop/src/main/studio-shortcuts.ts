/**
 * studio-shortcuts — global shortcuts for the (now sole) Studio window.
 *
 * Replaces active-ui.ts's `registerActiveUiShortcuts`/`applyActiveUiSwitch`
 * now that single-UI exclusivity has nothing to switch between: Studio is
 * the only conversation UI, so there is no live mode switch, no per-mode
 * shortcut set, and no `SurfacePlan` to resolve. Alt+Space always toggles
 * the Studio window; `studioShortcut` (a user-configurable accelerator, ''
 * = none) is a second binding for the same toggle.
 */
import { globalShortcut } from 'electron'
import { readSettings } from '@ion/server/persistence/settings-store'
import { toggleStudioWindow } from './studio-window-manager'
import { log as _log, warn as _warn } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('studio-shortcuts', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('studio-shortcuts', msg, fields)
}

/** Electron accelerator shape, loosely: token(+token)* — never arbitrary text. */
const ACCELERATOR_RE = /^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/

export const DEFAULT_STUDIO_SHORTCUT = 'Alt+Shift+Space'

/** Resolve the user's configured `studioShortcut`, falling back to the default when unset or malformed. */
export function resolveStudioShortcut(settings: Record<string, unknown> = readSettings()): string {
  const raw = typeof settings.studioShortcut === 'string' ? settings.studioShortcut : DEFAULT_STUDIO_SHORTCUT
  return ACCELERATOR_RE.test(raw) ? raw : ''
}

/**
 * Register the Studio window's global shortcuts. Called once at boot and
 * again from the settings funnel whenever `studioShortcut` changes.
 */
export function registerStudioShortcuts(): void {
  globalShortcut.unregisterAll()
  const registered = globalShortcut.register('Alt+Space', () => toggleStudioWindow('shortcut Alt+Space'))
  if (!registered) {
    warn('Alt+Space shortcut registration failed — macOS input sources may claim it')
  }
  const studioShortcut = resolveStudioShortcut()
  if (studioShortcut) {
    const ok = globalShortcut.register(studioShortcut, () => toggleStudioWindow(`shortcut ${studioShortcut}`))
    if (!ok) warn('studio shortcut registration failed', { accelerator: studioShortcut })
  }
  log('shortcuts registered', { studio_shortcut: studioShortcut || '' })
}
