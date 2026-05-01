import { IPC } from '../shared/types'
import { state, terminalOutputAccumulator } from './state'

export function broadcast(channel: string, ...args: unknown[]): void {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send(channel, ...args)
  }
  if (channel === IPC.TERMINAL_INCOMING && state.remoteTransport) {
    const key = args[0] as string
    const data = args[1] as string
    terminalOutputAccumulator.set(key, (terminalOutputAccumulator.get(key) || '') + data)
  } else if (channel === IPC.TERMINAL_EXIT && state.remoteTransport) {
    const key = args[0] as string
    const exitCode = args[1] as number
    const sep = key.indexOf(':')
    if (sep >= 0) {
      const tabId = key.substring(0, sep)
      const instanceId = key.substring(sep + 1)
      state.remoteTransport.send({ type: 'terminal_exit', tabId, instanceId, exitCode })
    }
  }
}

export function startTerminalOutputFlushing(): void {
  if (state.terminalOutputFlushTimer) return
  state.terminalOutputFlushTimer = setInterval(() => {
    if (terminalOutputAccumulator.size === 0) return
    for (const [key, data] of terminalOutputAccumulator) {
      const sep = key.indexOf(':')
      if (sep < 0) continue
      const tabId = key.substring(0, sep)
      const instanceId = key.substring(sep + 1)
      state.remoteTransport?.send({ type: 'terminal_output', tabId, instanceId, data })
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
