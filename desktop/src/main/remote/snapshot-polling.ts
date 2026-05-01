import { state } from '../state'
import { readSettings } from '../settings-store'
import { getRemoteTabStates } from './snapshot'

export function startTabSnapshotPolling(): void {
  stopTabSnapshotPolling()
  state.tabSnapshotInterval = setInterval(async () => {
    if (!state.remoteTransport || state.remoteTransport.state === 'disconnected') return
    try {
      const tabs = await getRemoteTabStates()
      const settings = readSettings()
      const recentDirectories: string[] = Array.isArray(settings.recentBaseDirectories) ? settings.recentBaseDirectories : []
      state.remoteTransport?.send({ type: 'snapshot', tabs, recentDirectories })
    } catch {}
  }, 5_000)
}

export function stopTabSnapshotPolling(): void {
  if (state.tabSnapshotInterval) {
    clearInterval(state.tabSnapshotInterval)
    state.tabSnapshotInterval = null
  }
}
