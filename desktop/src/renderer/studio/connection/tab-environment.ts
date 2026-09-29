/**
 * tab-environment — which Environment a piece of work belongs to (ADR-033;
 * plan: "Tabs carry `environmentId`. The Inbox is a union. A switcher is a
 * view filter, never a reconnect.").
 *
 * The desktop is connected to every catalogued Environment at once and its
 * one mirror store holds every Environment's tabs together. Nothing is ever
 * "switched to": a forwarded action goes to the server that owns the tab it
 * names, a file or git call goes to the server that owns the conversation
 * the operator is looking at, a terminal keystroke goes to the server that
 * owns the terminal's tab. These helpers are that routing, read from the
 * store at call time.
 *
 * `withTargetEnvironment` is the one explicit override: a creation that has
 * no tab yet (the new-conversation picker's Environment step) names where
 * the new tab should be born.
 */
import { useSessionStore } from '@ion/server/store/sessionStore'
import type { TabState } from '@ion/shared/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { isAbsolutePath } from '@ion/shared/paths'
import { FORWARDED_ACTIONS } from '@ion/shared/studio-mirror-actions'
import { splitTerminalActivityKey } from '@ion/shared/terminal-activity'
import { environmentOfWorkspacePath } from '../state/secondary-store-worktree-sync'

/** A tab's Environment; absent means the local one (see `TabState.environmentId`). */
export function tabEnvironmentId(tab: Pick<TabState, 'environmentId'> | null | undefined): string {
  return tab?.environmentId ?? LOCAL_ENVIRONMENT_ID
}

/**
 * A React key for a conversation in a list that spans machines.
 *
 * A transfer lands the destination's copy before it deletes the source's, so
 * the same conversation ID is briefly on two machines at once. Keyed by ID
 * alone, the two items collide and React can leave the source's item on
 * screen after its record is gone.
 */
export function tabListKey(tab: Pick<TabState, 'id' | 'environmentId'>): string {
  return `${tabEnvironmentId(tab)}:${tab.id}`
}

/** The store's current tab rows, tolerant of a partially-shaped store (a component test that mocks the selector only). */
function currentTabs(): { tabs: readonly TabState[]; settled: readonly TabState[]; activeTabId: string | null } {
  const getState = (useSessionStore as { getState?: () => unknown }).getState
  const state = typeof getState === 'function' ? (getState() as Partial<{ tabs: TabState[]; settledHistory: TabState[]; activeTabId: string | null }>) : {}
  return { tabs: Array.isArray(state.tabs) ? state.tabs : [], settled: Array.isArray(state.settledHistory) ? state.settledHistory : [], activeTabId: state.activeTabId ?? null }
}

/** The Environment of the tab with `tabId`, searching open tabs then settled history. Null when unknown. */
export function environmentOfTab(tabId: string | null | undefined): string | null {
  if (!tabId) return null
  const { tabs, settled } = currentTabs()
  const tab = tabs.find((t) => t.id === tabId) ?? settled.find((t) => t.id === tabId)
  return tab ? tabEnvironmentId(tab) : null
}

/** The Environment of the active tab, else local. */
export function activeTabEnvironmentId(): string {
  return environmentOfTab(currentTabs().activeTabId) ?? LOCAL_ENVIRONMENT_ID
}

/** React: the Environment of `tabId`, re-rendering when the tab's row changes. */
export function useTabEnvironmentId(tabId: string | null | undefined): string {
  return useSessionStore((s) => {
    if (!tabId) return LOCAL_ENVIRONMENT_ID
    const tab = s.tabs.find((t) => t.id === tabId) ?? s.settledHistory.find((t) => t.id === tabId)
    return tabEnvironmentId(tab)
  })
}

/** React: the Environment of the active tab, else local. */
export function useActiveTabEnvironmentId(): string {
  return useSessionStore((s) => tabEnvironmentId(s.tabs.find((t) => t.id === s.activeTabId)))
}

const targetStack: string[] = []

/**
 * Runs `fn` with `environmentId` as the explicit target for every forwarded
 * action and bridged shell call it issues SYNCHRONOUSLY. The store's
 * forwarded actions read their target at the top of the call, before any
 * await, so `withTargetEnvironment('grover', () => store.createConversationTab(dir))`
 * creates the conversation on grover even though the call is async.
 */
export function withTargetEnvironment<T>(environmentId: string, fn: () => T): T {
  targetStack.push(environmentId)
  try {
    return fn()
  } finally {
    targetStack.pop()
  }
}

/** The explicit target in force, if `withTargetEnvironment` is on the stack. */
export function explicitTargetEnvironment(): string | null {
  return targetStack.length > 0 ? targetStack[targetStack.length - 1] : null
}

/**
 * Where a forwarded store action goes: an explicit target, else the
 * Environment of the tab the action names (`FORWARDED_ACTIONS[name].tabIdAt`),
 * else the Environment whose worktree read model holds the workspace path it
 * names (`workspacePathAt`), else the active tab's Environment for an action
 * that acts on it (`activeTab`), else local. An action that names neither and
 * carries no explicit target is per-server bookkeeping that only ever meant
 * the local server (settings, panel toggles, pinned-tab order).
 */
export function resolveActionEnvironment(name: string, args: readonly unknown[]): string {
  const explicit = explicitTargetEnvironment()
  if (explicit) return explicit
  const at = FORWARDED_ACTIONS[name]?.tabIdAt
  if (at !== undefined) {
    const tabId = args[at]
    if (typeof tabId === 'string') {
      const owner = environmentOfTab(tabId)
      if (owner) return owner
    }
  }
  const pathAt = FORWARDED_ACTIONS[name]?.workspacePathAt
  if (pathAt !== undefined) {
    const path = args[pathAt]
    if (typeof path === 'string') {
      const owner = environmentOfWorkspacePath(path)
      if (owner) return owner
    }
  }
  // An action that acts on the active tab belongs to the environment that
  // owns the window's active tab.
  if (FORWARDED_ACTIONS[name]?.activeTab) return activeTabEnvironmentId()
  return LOCAL_ENVIRONMENT_ID
}

/** The window's active tab id, for an action that acts on it. */
export function activeTabIdForAction(name: string): string | undefined {
  if (!FORWARDED_ACTIONS[name]?.activeTab) return undefined
  return currentTabs().activeTabId ?? undefined
}

const PATH_ARG_KEYS = ['directory', 'filePath', 'targetPath', 'cwd', 'projectPath', 'repoPath', 'worktreePath'] as const

/**
 * Where a bridged `host.shell` verb goes, from the payload the bridge packed:
 *   - an explicit target wins;
 *   - a terminal key (`<tabId>:<instanceId>`) or a `tabId`/`key` names a tab,
 *     so the call goes to that tab's Environment;
 *   - a path (directory, file, cwd) names a filesystem, and the filesystem the
 *     operator is looking at is the active conversation's, so the call goes
 *     to the active tab's Environment;
 *   - anything else (models, settings, providers) is per-device bookkeeping
 *     against the local server.
 */
export function resolveShellEnvironment(packedArgs: readonly unknown[]): string {
  const explicit = explicitTargetEnvironment()
  if (explicit) return explicit
  const first = packedArgs[0]
  if (first && typeof first === 'object') {
    const obj = first as Record<string, unknown>
    const key = typeof obj.key === 'string' ? obj.key : null
    if (key) {
      const owner = environmentOfTab(splitTerminalActivityKey(key).tabId)
      if (owner) return owner
    }
    if (typeof obj.tabId === 'string') {
      const owner = environmentOfTab(obj.tabId)
      if (owner) return owner
    }
    if (PATH_ARG_KEYS.some((k) => typeof obj[k] === 'string')) return activeTabEnvironmentId()
  } else if (typeof first === 'string') {
    // Positional verbs (`git.isRepo(dir)`, `session.load(id)`): a tab id
    // routes to its owner; a path routes to the active conversation's server.
    const owner = environmentOfTab(first)
    if (owner) return owner
    if (isAbsolutePath(first) || first.startsWith('~')) return activeTabEnvironmentId()
  }
  return LOCAL_ENVIRONMENT_ID
}
