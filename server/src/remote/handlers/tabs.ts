import { clearAgentStateForTab } from '../../engine/agent-state-mirror'
import { log as _log, warn as _warn } from '../../logger'
import { state, sessionPlane, engineBridge, activeAssistantMessages, lastMessagePreview, lastForwardedTabStatus, extensionCommandRegistry } from '../../state'
import { useSessionStore } from '../../store/sessionStore'
import { evaluateRemoteCloseGuard, formatRemoteCloseGuardRefusal, type RemoteCloseGuardResult } from './tabs-close-guard'
import type { RemoteCommand } from '../protocol'
import { isThinkingEffort } from '@ion/shared/thinking-options'
import { applyRemotePermissionMode, applyRemoteThinkingEffort } from './remote-instance-state'
import { sendRemoteEvent } from '../../thin-view/remote-out'

export { handleCancel, handleAbortDispatch, handleSetDraft } from './tabs-prompt'
// Tab creation (and its desktop_tab_created echo) lives in tabs-create-echo.ts;
// re-exported here so callers keep one import site for the whole tab surface.
export { handleCreateTab, handleCreateTerminalTab } from './tabs-create-echo'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

/**
 * Close a conversation unless it has work in flight. The `tabs.close` Studio
 * action answers its caller with the returned guard, so a refusal can say
 * what is running.
 */
export async function closeTabGuarded(tabId: string): Promise<RemoteCloseGuardResult & { closed: boolean }> {
  // Same rule a client enforces on Cmd+W: refuse the close while the
  // orchestrator, a dispatched agent, or a background bash command is still
  // in flight. Closing anyway stops the engine session and orphans that work,
  // so no client may do remotely what it refuses locally. The guard reads the
  // projected tab states — the same cache a client's snapshot is served from,
  // so the guard and the row the user clicked agree.
  const cachedTabs = state.rendererSnapshotCache?.tabs ?? []
  const guard = evaluateRemoteCloseGuard(cachedTabs.find((t) => t.id === tabId))
  if (guard.blocked) {
    // No desktop_tab_closed is sent, so a client's next snapshot tick restores
    // the row if it removed it optimistically — the snapshot is authoritative
    // for tab existence, exactly as it is for every other tab field.
    warn('close_tab refused: work still in flight', formatRemoteCloseGuardRefusal(tabId, guard))
    return { ...guard, closed: false }
  }

  // The session store now runs in-process with this handler, so the tab's
  // real lifecycle policy (settle-vs-delete decision, busy guard, session
  // teardown) runs via a direct store call instead of an executeJavaScript
  // round-trip into a renderer. Whether closeTab actually removes the tab or
  // redirects it to settled history, the tab is gone from the live tabs list
  // either way, so the remote-command bookkeeping below always applies.
  useSessionStore.getState().closeTab(tabId)
  log('close_tab applied', { tab_id: tabId })

  sendRemoteEvent({ type: 'desktop_tab_closed', tabId })

  // Clean up all per-tab server-side state to prevent memory leaks.
  activeAssistantMessages.delete(tabId)
  lastMessagePreview.delete(tabId)
  lastForwardedTabStatus.delete(tabId)
  clearAgentStateForTab(tabId)
  for (const key of extensionCommandRegistry.keys()) {
    if (key === tabId || key.startsWith(`${tabId}:`)) extensionCommandRegistry.delete(key)
  }
  return { ...guard, closed: true }
}

/** Returns false, having changed nothing, for a mode outside the closed set. Also the body of the `session.setPermissionMode` Studio action. */
export async function handleSetPermissionMode(cmd: Pick<Extract<RemoteCommand, { type: 'desktop_set_permission_mode' }>, 'tabId' | 'mode'>): Promise<boolean> {
  const mode = cmd.mode
  if (mode !== 'auto' && mode !== 'plan') {
    log('set_permission_mode: invalid mode', { mode })
    return false
  }
  log('set_permission_mode', { tab_id: cmd.tabId, mode })

  // Engine tabs are keyed by `tabId:instanceId` in the engine.
  // The generic sessionPlane.setPermissionMode uses bare tabId which
  // silently misses the engine session. Detect engine tabs and route
  // through the compound-key bridge path.
  //
  // We also pull the active instance's planFilePath so an iOS-origin plan
  // toggle restores plan-file continuity identically to the desktop path:
  // when entering plan mode the engine re-adopts an existing on-disk plan
  // instead of allocating a fresh slug. Parity with tab-slice.ts.
  let routed = false
  let planFilePath: string | undefined
  const s = useSessionStore.getState()
  const tab = s.tabs.find((t) => t.id === cmd.tabId)
  if (tab) {
    const pane = s.conversationPanes.get(cmd.tabId)
    const inst = pane ? (pane.instances.find((i) => i.id === pane.activeInstanceId) ?? pane.instances[0]) : undefined
    const isEngine = !!tab.engineProfileId
    const instanceId = pane ? pane.activeInstanceId : null
    if (mode === 'plan' && inst?.planFilePath) {
      planFilePath = inst.planFilePath
    }
    if (isEngine && instanceId) {
      log('set_permission_mode: engine tab', { key: cmd.tabId, path: planFilePath ?? '' })
      engineBridge.sendSetPlanMode(cmd.tabId, mode === 'plan', undefined, 'remote', undefined, planFilePath)
      routed = true
    }
  }

  // CLI tabs (or fallback when engine detection fails)
  if (!routed) {
    sessionPlane.setPermissionMode(cmd.tabId, mode, 'remote', planFilePath)
  }

  // Record the mode on the store regardless of tab type, so every client
  // renders it and the next prompt reads it.
  applyRemotePermissionMode(cmd.tabId, mode)
  return true
}

/**
 * Apply a per-conversation thinking-effort change sent from iOS. There is no
 * engine command — thinking is a per-prompt override — so the handler writes
 * the level onto the targeted tab's active instance in the store (the same
 * state the desktop's own prompt-submit reads). The
 * next prompt from either client then carries the level. 'off' clears it.
 */
export async function handleSetThinkingEffort(cmd: Pick<Extract<RemoteCommand, { type: 'desktop_set_thinking_effort' }>, 'tabId' | 'effort'>): Promise<boolean> {
  const effort = cmd.effort
  // Validated against the shared ladder rather than an inline list: an inline
  // list silently rejected 'adaptive' after it was added to the type, dropping
  // the command with only a log line to show for it.
  if (!isThinkingEffort(effort)) {
    log('set_thinking_effort: invalid effort', { effort })
    return false
  }
  log('set_thinking_effort', { tab_id: cmd.tabId, effort })
  applyRemoteThinkingEffort(cmd.tabId, effort)
  return true
}
