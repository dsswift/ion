import { IPC } from '../shared/types'
import type { NormalizedEvent } from '../shared/types'
import { state, terminalOutputAccumulator, terminalScrollback, MAX_SCROLLBACK_SIZE } from './state'
import { studioWantsEvent, updateStudioCache } from './studio-state-cache'
import { maybeBeacon } from './studio-beacon'

export function broadcast(channel: string, ...args: unknown[]): void {
  if (channel === IPC.STARTUP_STATE) {
    const splash = state.splashWindow
    if (splash && !splash.isDestroyed()) splash.webContents.send(channel, ...args)
    return
  }
  if (channel === IPC.STUDIO_WORKTREE_SYNC) {
    const studio = state.studioWindow
    if (studio && !studio.isDestroyed()) studio.webContents.send(channel, ...args)
    return
  }
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send(channel, ...args)
  }
  // Ion Studio fan-out.
  //
  // Two consumers with different appetites:
  //   - The main-process Studio cache ingests only the canvas-relevant subset
  //     (studioWantsEvent) and runs even while the window is closed — it is the
  //     backfill the window pulls on open.
  //   - The Studio WINDOW, while open, receives the FULL stream (mirror-store
  //     architecture: the shell's session store consumes the same events as
  //     the overlay — text deltas included). The double structured-clone
  //     cost exists only while the window is open.
  if (channel === 'ion:normalized-event') {
    const tabId = args[0] as string
    const event = args[1] as NormalizedEvent
    if (event && studioWantsEvent(event)) {
      updateStudioCache(tabId, event)
    }
    if (event && state.studioWindow && !state.studioWindow.isDestroyed()) {
      state.studioWindow.webContents.send(channel, ...args)
      // Attention beacon: dock bounce + title prefix when a permission
      // arrives while the Studio window is open but unfocused.
      maybeBeacon(event)
    }
  } else if (
    (channel === 'ion:tab-status-change' || channel === 'ion:enriched-error' || channel === 'ion:settings-changed' || channel === 'ion:themes-changed' || channel === 'ion:engine-reconnected' || channel === IPC.DEEPLINK_CONFIRM_REQUEST || channel === IPC.DEEPLINK_CONFIRM_SETTLED || channel === IPC.UPDATE_DOWNLOADED || channel === IPC.UPDATE_PROGRESS || channel === IPC.UPDATE_STAGED || channel === IPC.UPDATE_ERROR) &&
    state.studioWindow &&
    !state.studioWindow.isDestroyed()
  ) {
    // Status transitions, enriched errors, settings changes, theme-pack
    // updates, and engine-reconnected signals feed the mirror store's
    // reducers exactly as they feed the overlay's. The mirror's mounted
    // useEngineEvents subscribes ion:engine-reconnected and re-arms its own
    // failed history hydration, so the forward must reach the Studio window.
    state.studioWindow.webContents.send(channel, ...args)
  }
  if (channel === IPC.TERMINAL_INCOMING) {
    const key = args[0] as string
    const data = args[1] as string
    // Accumulate into main-process scrollback UNCONDITIONALLY: the attach
    // protocol (TERMINAL_ATTACH) serves this buffer to any window that
    // attaches — it is the single source of terminal history, not just an
    // iOS-snapshot fallback, so it cannot be gated on remoteTransport.
    const prev = terminalScrollback.get(key) || ''
    const combined = prev + data
    terminalScrollback.set(key, combined.length > MAX_SCROLLBACK_SIZE
      ? combined.slice(combined.length - MAX_SCROLLBACK_SIZE)
      : combined)
    if (state.studioWindow && !state.studioWindow.isDestroyed()) {
      state.studioWindow.webContents.send(channel, ...args)
    }
    if (state.remoteTransport) {
      terminalOutputAccumulator.set(key, (terminalOutputAccumulator.get(key) || '') + data)
      // Re-arm the flush timer if it self-stopped while idle (see
      // startTerminalOutputFlushing). Idempotent: early-returns if already running.
      startTerminalOutputFlushing()
    }
  } else if (channel === IPC.TERMINAL_EXIT) {
    if (state.studioWindow && !state.studioWindow.isDestroyed()) {
      state.studioWindow.webContents.send(channel, ...args)
    }
    if (!state.remoteTransport) return
    const key = args[0] as string
    const exitCode = args[1] as number
    const sep = key.indexOf(':')
    if (sep >= 0) {
      const tabId = key.substring(0, sep)
      const instanceId = key.substring(sep + 1)
      state.remoteTransport.send({ type: 'desktop_terminal_exit', tabId, instanceId, exitCode })
    }
  }
}

export function startTerminalOutputFlushing(): void {
  if (state.terminalOutputFlushTimer) return
  state.terminalOutputFlushTimer = setInterval(() => {
    // Self-stop when idle: no buffered terminal output means the 16ms (~62.5Hz)
    // timer has no work. Clear it rather than waking the event loop forever
    // while a terminal is open but silent; broadcast() re-arms on the next chunk.
    if (terminalOutputAccumulator.size === 0) {
      if (state.terminalOutputFlushTimer) {
        clearInterval(state.terminalOutputFlushTimer)
        state.terminalOutputFlushTimer = null
      }
      return
    }
    for (const [key, data] of terminalOutputAccumulator) {
      const sep = key.indexOf(':')
      if (sep < 0) continue
      const tabId = key.substring(0, sep)
      const instanceId = key.substring(sep + 1)
      state.remoteTransport?.send({ type: 'desktop_terminal_output', tabId, instanceId, data })
    }
    terminalOutputAccumulator.clear()
  }, 16)
}

export function stopTerminalOutputFlushing(): void {
  if (state.terminalOutputFlushTimer) {
    clearInterval(state.terminalOutputFlushTimer)
    state.terminalOutputFlushTimer = null
  }
  terminalOutputAccumulator.clear()
}
