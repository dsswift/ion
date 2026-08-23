/**
 * project-registry-notifier — auto-populate seam (G1): a store
 * subscription that registers every conversation tab's base directory in
 * the project registry, bumping lastUsedAt when the active tab changes.
 *
 * Owner-window only (the mirror never persists preferences). Same
 * subscription pattern as active-tab-notifier, so tab creation AND
 * restoration both feed the registry without per-call wiring — every
 * current and future mutation of tabs/activeTabId is covered.
 */
import { rWarn } from '../rendererLogger'
import { resolveProjectIdentity } from './project-identity'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'

let unsubscribe: (() => void) | null = null
let lastRegisteredActive: string | null = null

function registerTabProject(tab: { workingDirectory: string; worktree?: { repoPath: string } | null }): void {
  void resolveProjectIdentity(tab, window.ion).then((dir) => {
    if (dir) usePreferencesStore.getState().registerProjectUse(dir)
  }).catch((error: unknown) => {
    rWarn('project.registry', 'project identity resolution failed', {
      directory: tab.workingDirectory,
      error: String(error),
    })
  })
}

function registerActiveTabDir(state: { activeTabId: string | null; tabs: Array<{ id: string; workingDirectory: string; worktree?: { repoPath: string } | null }> }): void {
  const tabId = state.activeTabId
  if (!tabId || tabId === lastRegisteredActive) return
  lastRegisteredActive = tabId
  const tab = state.tabs.find((t) => t.id === tabId)
  if (tab) registerTabProject(tab)
}

/** Start the notifier (idempotent). Called once from App mount (owner only). */
export function initProjectRegistryNotifier(): () => void {
  if (unsubscribe) return unsubscribe
  // Seed from the restored tab set (registers every restored dir once —
  // the registry rate-limits per-dir bumps internally).
  const initial = useSessionStore.getState()
  for (const tab of initial.tabs) registerTabProject(tab)
  registerActiveTabDir(initial)
  const off = useSessionStore.subscribe((state) => {
    registerActiveTabDir(state)
  })
  unsubscribe = () => {
    off()
    unsubscribe = null
    lastRegisteredActive = null
  }
  return unsubscribe
}
