/**
 * active-ui — single-UI exclusivity runtime (D1/F3).
 *
 * Owns the piece of state the resolver only computes: WHICH conversation
 * UI is live right now, its global shortcuts, and the LIVE switch between
 * the two. Flipping activeUi (Settings picker or enterprise push):
 *
 *   1. closes the active UI (hides the glass / closes the Studio window)
 *   2. opens the other
 *   3. re-registers global shortcuts for the new plan
 *   4. refreshes the tray (the inactive UI's items are ABSENT, not greyed)
 *
 * The owner renderer never restarts: the overlay window object survives in
 * both modes (hidden in studio mode), so engine connections, conversations,
 * and in-flight runs are uninterrupted. Terminals survive via the attach
 * model (main-owned ptys). All durable state is owner/main-side, so closing
 * the Studio window is always safe.
 */
import { globalShortcut } from 'electron'
import { resolveSurfacePlan, type SurfacePlan } from './surface-launch'
import { readSettings } from './settings-store'
import { enterprisePolicyCache, state } from './state'
import { showWindow, toggleWindow, createTray } from './window-manager'
import { openStudioWindow, toggleStudioWindow } from './studio-window-manager'
import { log as _log, warn as _warn } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('active-ui', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('active-ui', msg, fields)
}

/** The current resolved plan (refreshed on every switch). */
let currentPlan: SurfacePlan | null = null

export function getActiveUiPlan(): SurfacePlan {
  if (!currentPlan) currentPlan = resolveSurfacePlan(readSettings(), enterprisePolicyCache.policy)
  return currentPlan
}

/**
 * Register the active UI's global shortcuts. Alt+Space always reaches the
 * one UI that exists; the Studio's own accelerator exists only in studio
 * mode. Cmd/Ctrl+Shift+K keeps its historical overlay binding in overlay
 * mode only (the glass does not exist in studio mode).
 */
export function registerActiveUiShortcuts(plan: SurfacePlan): void {
  currentPlan = plan
  const altSpaceTarget = plan.activeUi === 'studio'
    ? (): void => toggleStudioWindow('shortcut Alt+Space (studio mode)')
    : (): void => toggleWindow('shortcut Alt+Space (overlay mode)')
  const registered = globalShortcut.register('Alt+Space', altSpaceTarget)
  if (!registered) {
    warn('Alt+Space shortcut registration failed — macOS input sources may claim it', { active_ui: plan.activeUi })
  }
  if (plan.overlayEnabled) {
    const overlayShortcutRegistered = globalShortcut.register(
      'CommandOrControl+Shift+K',
      () => toggleWindow('shortcut CommandOrControl+Shift+K (overlay mode)'),
    )
    if (!overlayShortcutRegistered) {
      warn('overlay shortcut registration failed', { accelerator: 'CommandOrControl+Shift+K' })
    }
  }
  if (plan.studioShortcut) {
    const ok = globalShortcut.register(plan.studioShortcut, () => toggleStudioWindow(`shortcut ${plan.studioShortcut}`))
    if (!ok) warn('studio shortcut registration failed', { accelerator: plan.studioShortcut })
  }
  log('shortcuts registered', { active_ui: plan.activeUi, studio_shortcut: plan.studioShortcut || '' })
}

/**
 * Live mode switch: resolve the new plan and swap UIs without restarting
 * the owner renderer. Called from the settings funnel when activeUi
 * changes and from the enterprise policy refresh.
 */
export function applyActiveUiSwitch(): void {
  const prev = currentPlan
  const next = resolveSurfacePlan(readSettings(), enterprisePolicyCache.policy)
  currentPlan = next
  if (prev && prev.activeUi === next.activeUi && prev.studioShortcut === next.studioShortcut) {
    log('active-ui unchanged, no switch', { active_ui: next.activeUi })
    return
  }
  log('live mode switch', { from: prev?.activeUi ?? '(boot)', to: next.activeUi })

  // 1. Tear down all shortcuts; re-register below for the new mode.
  globalShortcut.unregisterAll()

  // 2/3. Swap the visible UI. Owner renderer untouched throughout: the
  // overlay window HIDES (its renderer keeps running as the store owner);
  // the Studio window CLOSES (all durable state is owner/main-side, and
  // surface terminals survive via the main-owned attach model).
  if (next.activeUi === 'studio') {
    if (state.mainWindow && !state.mainWindow.isDestroyed() && state.mainWindow.isVisible()) {
      state.mainWindow.hide()
    }
    openStudioWindow('active-ui switch')
  } else {
    if (state.studioWindow && !state.studioWindow.isDestroyed()) {
      state.studioWindow.close()
    }
    showWindow('active-ui switch')
  }

  // 4. Shortcuts + tray for the new mode (tray rebuild drops the inactive
  // UI's items entirely).
  registerActiveUiShortcuts(next)
  if (state.tray) createTray()
}
