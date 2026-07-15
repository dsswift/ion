import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { buildClearDividerRemoteEvent } from '../../shared/clear-divider'
import { log as _log } from '../logger'
import { isValidProjectPath } from '../ipc-validation'
import { engineBridge, sessionPlane, state } from '../state'
import { broadcastEngineHistory } from '../remote/handlers/engine-history'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

/**
 * Validate a renderer/iOS-supplied planFilePath before forwarding it to the
 * engine. planFilePath is an absolute instruction-file path; an invalid value
 * degrades to "no restore" (undefined) rather than aborting the plan-mode
 * toggle — enabling plan mode without a restore file is still the correct
 * outcome. Returns the validated path, or undefined when absent or malformed.
 */
export function sanitizePlanFilePath(planFilePath: string | undefined, channel: string): string | undefined {
  if (!planFilePath) return undefined
  if (!isValidProjectPath(planFilePath)) {
    log('engine_start: rejecting malformed planFilePath', { channel })
    return undefined
  }
  return planFilePath
}

export function registerEngineIpc(): void {
  ipcMain.handle(IPC.ENGINE_START, async (_event, { key, config }: { key: string; config: import('../../shared/types').EngineConfig }) => {
    log('engine_start', { key, extensions: config.extensions?.join(',') ?? '', session_id: config.sessionId ?? 'none' })
    // Seed the control-plane TabEntry with the resolved conversationId BEFORE the
    // engine session starts. This IPC starts the session via engineBridge
    // directly (bypassing EngineControlPlane.ensureSession, which is the only
    // other start site that seeds conversationId). Without this seed, an
    // extension-hosted restored tab has no tracked id when the engine emits its
    // first idle status, so the engine_status first-bind branch adopts whatever
    // id the engine reports — including an empty pre-minted id on a restore that
    // supplied none. Seeding here arms the divergence guard. Idempotent: a no-op
    // when the tab already tracks an id.
    if (config.sessionId) {
      sessionPlane.seedConversationId(key, config.sessionId)
    }
    return engineBridge.startSession(key, config)
  })

  ipcMain.handle(IPC.ENGINE_ABORT, (_event, { key }: { key: string }) => {
    log('engine_abort', { key })
    engineBridge.sendAbort(key)
  })

  ipcMain.handle(
    IPC.ENGINE_ABORT_AGENT,
    (_event, { key, agentName, subtree }: { key: string; agentName: string; subtree?: boolean }) => {
      log('engine_abort_agent', { key, agent: agentName, subtree: subtree ?? false })
      engineBridge.sendAbortAgent(key, agentName, subtree ?? false)
    },
  )

  ipcMain.handle(IPC.ENGINE_DIALOG_RESPONSE, (_event, { key, dialogId, value }: { key: string; dialogId: string; value: any }) => {
    log('engine_dialog_response', { key, dialog_id: dialogId })
    engineBridge.sendDialogResponse(key, dialogId, value)
  })

  ipcMain.handle(IPC.ENGINE_COMMAND, (_event, { key, command, args }: { key: string; command: string; args: string }) => {
    log('engine_command', { key, command })
    engineBridge.sendCommand(key, command, args)
    // Mirror /clear divider to iOS so the remote client sees the checkpoint
    // immediately, without waiting for a conversation reload. The renderer
    // has already inserted the divider into its local message store via
    // addSystemMessage / addEngineSystemMessage; here we relay it to iOS.
    // The envelope kind (engine_harness_message vs. message_added) is keyed
    // by the engine session key shape — see buildClearDividerRemoteEvent.
    if (command === 'clear' && state.remoteTransport) {
      state.remoteTransport.send(buildClearDividerRemoteEvent(key, new Date()))
    }
  })

  ipcMain.handle(IPC.ENGINE_STOP, (_event, { key }: { key: string }) => {
    log('engine_stop', { key })
    engineBridge.stopSession(key)
  })

  ipcMain.handle(IPC.ENGINE_BRANCH_BEFORE, async (_event, { key, entryId }: { key: string; entryId: string }) => {
    // Tree-native rewind: move the conversation leaf to the parent of the
    // given entry so the next prompt replaces it on the active path. Errors
    // reject the invoke so the renderer can log the failure (an unknown
    // entry is expected when the rewound session got a genuinely fresh
    // conversation instead of a rebound one).
    log('engine_branch_before', { key, entry_id: entryId })
    await engineBridge.branchSessionBefore(key, entryId)
  })

  ipcMain.handle(IPC.ENGINE_REWIND, async (_event, { key, userTurnIndex }: { key: string; userTurnIndex: number }) => {
    // Ordinal-addressed tree-native rewind. The engine resolves the user-turn
    // ordinal against its own tree, moves the leaf to before that turn, and
    // restores plan-file continuity — so the next prompt replaces the turn on a
    // fresh branch with no duplicate. Errors surface to the renderer via the
    // returned result so a failed rewind is logged, not silent.
    log('engine_rewind', { key, user_turn_index: userTurnIndex })
    return engineBridge.rewindSession(key, userTurnIndex)
  })

  ipcMain.handle(IPC.ENGINE_GET_CONTEXT_BREAKDOWN, (_event, { key }: { key: string }) => {
    log('engine_get_context_breakdown', { key })
    // Fire-and-forget. The engine emits engine_context_breakdown on its event
    // bus; the existing event-wiring handler translates it to context_breakdown
    // and broadcasts to the renderer. The IPC reply is empty — the caller
    // observes the result through the engine event stream.
    engineBridge._send({ cmd: 'get_context_breakdown', key })
  })

  ipcMain.handle(IPC.ENGINE_REMAP_SESSION, (_event, { oldKey, newKey }: { oldKey: string; newKey: string }) => {
    log('engine_remap_session', { old_key: oldKey, new_key: newKey })
    engineBridge.remapSession(oldKey, newKey)
  })

  ipcMain.handle(IPC.ENGINE_BROADCAST_HISTORY, async (_event, { tabId, instanceId }: { tabId: string; instanceId: string | null }) => {
    log('engine_broadcast_history', { tab_id: tabId, instance_id: instanceId || '' })
    await broadcastEngineHistory(tabId, instanceId)
  })

  ipcMain.on(IPC.SET_PERMISSION_MODE, (_event, payload: { tabId: string; mode: string; source?: string; planFilePath?: string }) => {
    const { tabId, mode, source, planFilePath } = payload
    if (mode !== 'auto' && mode !== 'plan') {
      log('set_permission_mode: invalid mode', { mode })
      return
    }
    const safePlanFilePath = sanitizePlanFilePath(planFilePath, 'SET_PERMISSION_MODE')
    log('set_permission_mode', { tab_id: tabId, mode, source: source ?? 'unknown', plan_file_path: safePlanFilePath ?? '' })
    sessionPlane.setPermissionMode(tabId, mode, source, safePlanFilePath)
  })

  ipcMain.on('ion:engine-set-plan-mode', (_event, key: string, enabled: boolean, planFilePath?: string) => {
    const safePlanFilePath = sanitizePlanFilePath(planFilePath, 'engine-set-plan-mode')
    log('engine_set_plan_mode', { key, enabled, plan_file_path: safePlanFilePath ?? '' })
    // planFilePath restores plan-file continuity when enabling plan mode on a
    // session that lost its in-memory path (e.g. after restart / rebind). The
    // engine re-adopts it if it exists on disk; ignored on disable. Forwarded
    // as the 6th sendSetPlanMode arg (bash allowlist stays undefined here —
    // the extension-instance plan toggle does not project the allowlist).
    engineBridge.sendSetPlanMode(key, enabled, undefined, 'prompt_sync', undefined, safePlanFilePath)
  })

  // ─── Plugin management ───
  ipcMain.handle('plugin:install', async (_event, source: string) => {
    log('plugin_install', { source })
    return engineBridge.request('plugin_install', { source })
  })

  ipcMain.handle('plugin:list', async () => {
    log('plugin_list')
    return engineBridge.request('plugin_list', {})
  })

  ipcMain.handle('plugin:remove', async (_event, name: string) => {
    log('plugin_remove', { name })
    return engineBridge.request('plugin_remove', { label: name })
  })
}
