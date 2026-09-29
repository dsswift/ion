import { IPC } from '@ion/shared/types'
import { state } from './state'

/**
 * Push one main-process event to the window that renders it.
 *
 * Only the pushes this process still originates go through here: startup
 * progress to the splash, the updater's lifecycle signals, and this device's
 * own Device Metrics to the Studio window. Everything the engine or the session store produces -- the
 * normalized event stream, tab status, terminal output, settings and theme
 * changes, deep-link confirmations, resource and questions state -- is the
 * Studio server's (ADR-033) and reaches the window as `studio_event` frames
 * over `ipc/studio-bridge.ts`. A channel this function does not name is
 * dropped: there is no producer for it in this process any more.
 */
const STUDIO_WINDOW_CHANNELS: ReadonlySet<string> = new Set([
  IPC.UPDATE_DOWNLOADED,
  IPC.UPDATE_PROGRESS,
  IPC.UPDATE_STAGED,
  IPC.UPDATE_ERROR,
  IPC.DEVICE_METRICS,
])

export function broadcast(channel: string, ...args: unknown[]): void {
  if (channel === IPC.STARTUP_STATE) {
    const splash = state.splashWindow
    if (splash && !splash.isDestroyed()) splash.webContents.send(channel, ...args)
    return
  }
  if (!STUDIO_WINDOW_CHANNELS.has(channel)) return
  const studio = state.studioWindow
  if (studio && !studio.isDestroyed()) studio.webContents.send(channel, ...args)
}
