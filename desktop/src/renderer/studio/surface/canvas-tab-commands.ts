/**
 * Canvas-tab shortcut wiring — the one place that maps a canvas singleton to
 * its command ID.
 *
 * Both the keyboard handlers (StudioShell) and the on-pill hints
 * (SurfaceTabStrip) read this map, so a tab can never end up with a working
 * chord and no hint, or a hint for a chord nothing dispatches.
 */

import type { SingletonId } from '../../../shared/studio-surface-types'
import { NOTIFICATION_SURFACE_ID } from '../../../shared/studio-surface-types'

/** Every canvas tab id that owns a command, including the notification tab. */
export type CanvasTabId = SingletonId | typeof NOTIFICATION_SURFACE_ID

export const CANVAS_TAB_COMMANDS: Readonly<Record<CanvasTabId, string>> = {
  diff: 'studio.surface.diff',
  plan: 'studio.surface.plan',
  visualizer: 'studio.surface.visualizer',
  status: 'studio.surface.status',
  files: 'studio.surface.files',
  gitpanel: 'studio.surface.gitpanel',
  notification: 'studio.surface.notification',
}

export const CANVAS_TAB_COMMAND_IDS: readonly string[] = Object.values(CANVAS_TAB_COMMANDS)

/** The command for a surface tab id, or null for a file/browser/terminal tab. */
export function canvasTabCommand(tabId: string): string | null {
  return CANVAS_TAB_COMMANDS[tabId as CanvasTabId] ?? null
}
