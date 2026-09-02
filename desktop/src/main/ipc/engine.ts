import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { buildClearDividerRemoteEvent } from '../../shared/clear-divider'
import type { AbortScope } from '../../shared/types-engine'
import { log as _log, warn as _warn } from '../logger'
import { isValidProjectPath } from '../ipc-validation'
import { engineBridge, sessionPlane, state } from '../state'
import { broadcastEngineHistory } from '../remote/handlers/engine-history'
import { readPlanBashAllowlist, writePlanBashAllowlist } from '../plan-bash-allowlist-store'
import { broadcastDesktopSettingsSnapshot } from '../settings-broadcast'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
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

  ipcMain.handle(IPC.ENGINE_ABORT, (_event, { key, scope }: { key: string; scope?: AbortScope }) => {
    // An unrecognized scope is normalized here rather than forwarded: the
    // engine would default it to 'all' anyway, and normalizing at the boundary
    // keeps the log honest about what was actually sent.
    const resolved: AbortScope = scope === 'orchestrator' || scope === 'all_work' ? scope : 'all'
    if (scope !== undefined && scope !== resolved) {
      warn('engine_abort: unknown scope, defaulting to all', { key, requested: String(scope) })
    }
    log('engine_abort', { key, abort_scope: resolved })
    engineBridge.sendAbort(key, resolved)
  })

  ipcMain.handle(
    IPC.ENGINE_ABORT_DISPATCH,
    (_event, { key, dispatchId }: { key: string; dispatchId: string }) => {
      // A blank id addresses nothing and the engine rejects it; drop it here so
      // the reason is visible on the desktop side too.
      if (typeof dispatchId !== 'string' || dispatchId.trim() === '') {
        warn('engine_abort_dispatch: rejecting empty dispatchId', { key })
        return
      }
      log('engine_abort_dispatch', { key, dispatch_id: dispatchId })
      engineBridge.sendAbortDispatch(key, dispatchId)
    },
  )

  ipcMain.handle(
    IPC.ENGINE_STOP_BACKGROUND_TASK,
    async (_event, { key, taskId }: { key: string; taskId: string }) => {
      if (typeof taskId !== 'string' || taskId.trim() === '') {
        warn('engine_stop_background_task: rejecting empty taskId', { key })
        return { ok: false, error: 'taskId is required' }
      }
      log('engine_stop_background_task', { key, task_id: taskId })
      const result = await engineBridge.stopBackgroundTask(key, taskId)
      if (!result.ok) {
        warn('engine_stop_background_task: engine rejected request', { key, task_id: taskId, error: result.error ?? 'unknown error' })
      } else {
        log('engine_stop_background_task: completed', { key, task_id: taskId, status: result.status ?? 'unknown' })
      }
      return result
    },
  )

  // Plan-mode Bash allowlist: read from / write to engine.json. This is
  // engine policy edited through the desktop's Settings UI. On write we also
  // re-broadcast the desktop_settings_snapshot so any paired iOS device that
  // renders this key updates immediately (iOS reads the projected value, which
  // is sourced from engine.json — it never learns the storage location).
  ipcMain.handle(IPC.GET_PLAN_BASH_ALLOWLIST, () => {
    const cmds = readPlanBashAllowlist()
    log('get_plan_bash_allowlist', { count: cmds.length })
    return cmds
  })

  ipcMain.handle(IPC.SET_PLAN_BASH_ALLOWLIST, (_event, cmds: unknown) => {
    if (!Array.isArray(cmds) || !cmds.every((c) => typeof c === 'string')) {
      log('set_plan_bash_allowlist: rejecting non-string-array payload')
      return
    }
    writePlanBashAllowlist(cmds as string[])
    broadcastDesktopSettingsSnapshot('set_plan_bash_allowlist')
  })


  ipcMain.handle(IPC.ENGINE_DIALOG_RESPONSE, (_event, { key, dialogId, value }: { key: string; dialogId: string; value: any }) => {
    log('engine_dialog_response', { key, dialog_id: dialogId })
    engineBridge.sendDialogResponse(key, dialogId, value).catch((err) => warn('engine_dialog_response: send failed', { key, dialog_id: dialogId, error: String(err) }))
  })

  ipcMain.handle(IPC.ENGINE_COMMAND, (_event, { key, command, args }: { key: string; command: string; args: string }) => {
    log('engine_command', { key, command })
    engineBridge.sendCommand({ key, text: `/${command}${args ? ` ${args}` : ''}` }, command, args).catch((err) => warn('engine_command: send failed', { key, command, error: String(err) }))
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
    // Guided-questions workflows deliberately survive a stop: the question
    // is PARKED (the engine already terminated the run when AskUserQuestions
    // was called), so there is nothing running to stop and the retained
    // denial keeps re-publishing. Retiring here was the "Stop destroyed my
    // answers" defect.
    engineBridge.stopSession(key).catch((err) => warn('engine_stop: stop session failed', { key, error: String(err) }))
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

  ipcMain.handle(IPC.ENGINE_REWIND, async (_event, { key, entryId, userTurnIndex }: { key: string; entryId?: string; userTurnIndex?: number }) => {
    // Exact-entry-addressed tree-native rewind when entryId is supplied
    // (learned from a prior engine_steer_injected confirmation, or from
    // loaded conversation history): the engine validates it names a genuine
    // user turn on the CURRENT context path before branching, rejecting a
    // stale or foreign-branch id rather than silently landing on the wrong
    // turn. Falls back to the ordinal when entryId is absent — same tree
    // resolution behavior as before. Errors surface to the renderer via the
    // returned result so a failed rewind is logged, not silent.
    log('engine_rewind', { key, entry_id: entryId ?? '', user_turn_index: userTurnIndex ?? -1 })
    return engineBridge.rewindSession(key, { entryId, userTurnIndex })
  })

  ipcMain.handle(IPC.ENGINE_FORK, async (_event, payload: { key: string; newKey: string; messageIndex: number; entryId?: string; userTurnIndex?: number }) => {
    log('engine_fork', { key: payload.key, new_key: payload.newKey, message_index: payload.messageIndex ?? -1, entry_id: payload.entryId ?? '', user_turn_index: payload.userTurnIndex ?? -1 })
    return sessionPlane.forkSession(payload.key, payload.newKey, payload)
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

  ipcMain.handle(IPC.ENGINE_BROADCAST_HISTORY, async (_event, { tabId, instanceId, opts }: { tabId: string; instanceId: string | null; opts?: { queueUntilTabExists?: boolean } }) => {
    log('engine_broadcast_history', { tab_id: tabId, instance_id: instanceId || '', queue_until_tab_exists: opts?.queueUntilTabExists ?? false })
    await broadcastEngineHistory(tabId, instanceId, opts)
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

  ipcMain.on(IPC.RESOLVE_PERMISSION_DENIALS, (_event, payload: { tabId: string }) => {
    const tabId = payload?.tabId
    if (typeof tabId !== 'string' || tabId.length === 0 || tabId.length > 128) {
      log('resolve_permission_denials: invalid tabId')
      return
    }
    log('resolve_permission_denials: ipc', { tab_id: tabId })
    sessionPlane.resolvePermissionDenials(tabId)
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
