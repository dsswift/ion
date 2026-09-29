import { IPC } from '@ion/shared/types'
import { terminalOutputAccumulator, terminalScrollback, MAX_SCROLLBACK_SIZE, state } from './state'
import { publishStudioEvent } from './protocol/events'
import { sendRemoteEvent, remoteClientsPresent } from './thin-view/remote-out'

/**
 * The server's window-fan-out `broadcast()`.
 *
 * The desktop's `broadcast()` (`desktop/src/main/broadcast.ts`, unmoved by
 * this child — see its own Relevant Files note) delivers every channel to an
 * Electron `BrowserWindow.webContents`. The server has no window: every
 * channel is instead handed to `publishStudioEvent` (`protocol/events.ts`),
 * which fans a `studio_event` frame out to every attached Studio connection
 * for the channels in the wire contract (`@ion/shared/studio-wire/channels`)
 * and is a no-op for everything else (most `broadcast()` callers exist for
 * desktop-only, per-window UI channels that were never part of this
 * contract). Terminal output additionally keeps the two effects that were
 * always genuinely headless: accumulating scrollback for the remote
 * transport, and starting/stopping the terminal output flush timer.
 */
export function broadcast(channel: string, ...args: unknown[]): void {
  publishStudioEvent(channel, args)
  if (channel === IPC.TERMINAL_INCOMING) {
    const key = args[0] as string
    const data = args[1] as string
    const prev = terminalScrollback.get(key) || ''
    const combined = prev + data
    terminalScrollback.set(key, combined.length > MAX_SCROLLBACK_SIZE
      ? combined.slice(combined.length - MAX_SCROLLBACK_SIZE)
      : combined)
    if (remoteClientsPresent()) {
      terminalOutputAccumulator.set(key, (terminalOutputAccumulator.get(key) || '') + data)
      startTerminalOutputFlushing()
    }
  } else if (channel === IPC.TERMINAL_ACTIVITY) {
    const activity = args[0] as import('@ion/shared/terminal-activity').TerminalActivity
    if (remoteClientsPresent() && activity?.tabId) {
      sendRemoteEvent({
        type: 'desktop_terminal_activity',
        key: activity.key,
        tabId: activity.tabId,
        instanceId: activity.instanceId,
        active: activity.active,
        processLabel: activity.processLabel,
        applications: activity.applications,
      })
    }
  } else if (channel === IPC.TERMINAL_EXIT) {
    if (!remoteClientsPresent()) return
    const key = args[0] as string
    const exitCode = args[1] as number
    const sep = key.indexOf(':')
    if (sep >= 0) {
      const tabId = key.substring(0, sep)
      const instanceId = key.substring(sep + 1)
      sendRemoteEvent({ type: 'desktop_terminal_exit', tabId, instanceId, exitCode })
    }
  } else if (channel === IPC.TERMINAL_RESTARTED) {
    if (!remoteClientsPresent()) return
    const key = args[0] as string
    const sep = key.indexOf(':')
    if (sep >= 0) {
      sendRemoteEvent({ type: 'desktop_terminal_restarted', tabId: key.substring(0, sep), instanceId: key.substring(sep + 1) })
    }
  } else if (channel === 'studio:presence') {
    // FR-02: mirrors the studio-wire presence broadcast onto the iOS wire.
    if (remoteClientsPresent()) {
      const snapshot = args[0] as import('@ion/shared/types-presence').PresenceSnapshot
      sendRemoteEvent({ type: 'desktop_presence', entries: snapshot.entries, driving: snapshot.driving })
    }
  }
}

export function startTerminalOutputFlushing(): void {
  if (state.terminalOutputFlushTimer) return
  state.terminalOutputFlushTimer = setInterval(() => {
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
      sendRemoteEvent({ type: 'desktop_terminal_output', tabId, instanceId, data })
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
