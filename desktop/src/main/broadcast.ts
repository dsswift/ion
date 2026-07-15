import { IPC } from '../shared/types'
import type { NormalizedEvent } from '../shared/types'
import { state, terminalOutputAccumulator, terminalScrollback, MAX_SCROLLBACK_SIZE } from './state'
import { atvWantsEvent, updateAtvCache } from './atv-state-cache'

export function broadcast(channel: string, ...args: unknown[]): void {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send(channel, ...args)
  }
  // Agent Team Visualizer fan-out. Only the ATV-relevant subset of the
  // normalized stream is cached and forwarded — text deltas and tool chunks
  // run at ~60/s and a second webContents would pay structured-clone
  // serialization for events it never renders. The cache tap runs even when
  // the ATV window is closed: it is the backfill the window pulls on open.
  if (channel === 'ion:normalized-event') {
    const tabId = args[0] as string
    const event = args[1] as NormalizedEvent
    if (event && atvWantsEvent(event)) {
      updateAtvCache(tabId, event)
      if (state.atvWindow && !state.atvWindow.isDestroyed()) {
        state.atvWindow.webContents.send(channel, ...args)
      }
    }
  }
  if (channel === IPC.TERMINAL_INCOMING && state.remoteTransport) {
    const key = args[0] as string
    const data = args[1] as string
    terminalOutputAccumulator.set(key, (terminalOutputAccumulator.get(key) || '') + data)
    // Re-arm the flush timer if it self-stopped while idle (see
    // startTerminalOutputFlushing). Idempotent: early-returns if already running.
    startTerminalOutputFlushing()
    // Accumulate into main-process scrollback for snapshot fallback.
    const prev = terminalScrollback.get(key) || ''
    const combined = prev + data
    terminalScrollback.set(key, combined.length > MAX_SCROLLBACK_SIZE
      ? combined.slice(combined.length - MAX_SCROLLBACK_SIZE)
      : combined)
  } else if (channel === IPC.TERMINAL_EXIT && state.remoteTransport) {
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
