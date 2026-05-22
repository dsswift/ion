import { state, modelCache } from '../state'
import { readSettings } from '../settings-store'
import { getRemoteTabStates } from './snapshot'
import { reconcileGitWatchedDirectories } from './git-watcher-bridge'

export function startTabSnapshotPolling(): void {
  stopTabSnapshotPolling()
  state.tabSnapshotInterval = setInterval(async () => {
    if (!state.remoteTransport || state.remoteTransport.state === 'disconnected') return
    try {
      const tabs = await getRemoteTabStates()
      const settings = readSettings()
      const recentDirectories: string[] = Array.isArray(settings.recentBaseDirectories) ? settings.recentBaseDirectories : []
      const tabGroupMode = settings.tabGroupMode || 'off'
      const tabGroups = Array.isArray(settings.tabGroups) ? settings.tabGroups.map((g: any) => ({ id: g.id, label: g.label, isDefault: g.isDefault, order: g.order })) : []
      state.remoteTransport?.send({ type: 'snapshot', tabs, recentDirectories, tabGroupMode, tabGroups, preferredModel: settings.preferredModel || undefined, engineDefaultModel: settings.engineDefaultModel || undefined, availableModels: modelCache.models.length > 0 ? modelCache.models : undefined })
      // Reconcile git-watcher bridge with current tab directories
      const directories = new Set(tabs.map(t => t.workingDirectory).filter(Boolean))
      reconcileGitWatchedDirectories(directories)
    } catch {}
  }, 5_000)
}

export function stopTabSnapshotPolling(): void {
  if (state.tabSnapshotInterval) {
    clearInterval(state.tabSnapshotInterval)
    state.tabSnapshotInterval = null
  }
}
