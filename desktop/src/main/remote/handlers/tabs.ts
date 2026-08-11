import { readFile } from 'fs/promises'
import { getAgentState, getStatusFields, getWorkingMessage, getKnownInstanceId, clearAgentStateForTab } from '../../agent-state-mirror'
import { resolveEngineModel } from '../../resolve-engine-model'
import { IPC } from '../../../shared/types'
import { log as _log, warn as _warn } from '../../logger'
import { state, sessionPlane, engineBridge, activeAssistantMessages, lastMessagePreview, lastForwardedTabStatus, extensionCommandRegistry } from '../../state'
import { broadcast } from '../../broadcast'
import { terminalManager } from '../../terminal-manager-instance'
import { readClaudeCompat } from '../../settings-store'
import { autoPullDiagnosticLogs } from './diagnostics'
import { sendSync } from './tabs-sync'
import { evaluateRemoteCloseGuard, formatRemoteCloseGuardRefusal } from './tabs-close-guard'
import { resolveTabSessionChain, paginateHistory, planPathFromHistory, toRemoteMessage } from './tabs-session-chain'
import { mapSessionHistory } from '../../../shared/session-message-mapper'
import { decideLoad, recordLoadResponse } from './load-conversation-gate'
import { resolveDiscoveryWorkingDir } from '../../ipc-validation'
import { lookupClientMsgId, clearClientMsgIdsForTab } from '../client-msg-id-map'
import type { RemoteCommand, RemoteEvent } from '../protocol'
import { isThinkingEffort } from '../../../shared/thinking-options'

export { handlePrompt, handleCancel } from './tabs-prompt'
// Tab creation (and its desktop_tab_created echo) lives in tabs-create-echo.ts;
// re-exported here so command-handler.ts and the wire tests keep one import
// site for the whole tab-command surface.
export { handleCreateTab, handleCreateTerminalTab } from './tabs-create-echo'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

/**
 * Push the latest engine state (agents, status fields, working message,
 * model override) for a tab to the remote transport. Called after a
 * successful `desktop_load_conversation` response when the session is
 * currently running, so the mobile client overwrites any stale local state
 * from a previous session.
 *
 * The gate is purely on runtime session status ('running' | 'connecting'),
 * NOT on tab type or extension presence. After WI-001/WI-002, any
 * conversation's messages live on the active instance regardless of backend;
 * the same live-state push applies whenever the session is running.
 *
 * Engine contract: `engine_agent_state` is a complete snapshot, and we forward
 * unconditionally INCLUDING the empty case — an empty `agents: []` payload is
 * the authoritative "drop your stale rows" signal, without which an iOS
 * reconnect shows ghost agents from connections ago. See
 * docs/architecture/agent-state.md.
 *
 * Agents come from the main-process mirror (agent-state-mirror.ts), not from
 * the renderer. Main receives `engine_agent_state` first and forwards it on,
 * so asking the renderer for it read a downstream copy of data main already
 * had — and made the renderer serialize the whole roster across IPC on every
 * resync, which with the 35 MB payload from the production incident was tens
 * of megabytes of structured-clone work on the UI thread.
 */
async function sendCurrentEngineState(tabId: string, deviceId: string): Promise<void> {
  if (!state.remoteTransport) return

  // Every field below comes from main-owned state. There is no renderer
  // round-trip: main receives engine_agent_state, engine_status, and
  // engine_working_message first and forwards them on, so asking the renderer
  // for any of them read a downstream copy of what main already had.
  const instanceId = getKnownInstanceId(tabId)
  const agents = getAgentState(tabId, instanceId)
  const status = getStatusFields(tabId, instanceId)
  const working = getWorkingMessage(tabId, instanceId)
  // Model resolution reads the settings store, which can throw on a corrupt
  // file. A resync that dies here would leave the phone with no agent state at
  // all, so fall back rather than abort the whole push.
  let model = ''
  try {
    model = resolveEngineModel(tabId, instanceId)
  } catch (err) {
    warn('send_current_engine_state: model resolution failed', { tab_id: tabId, error: (err as Error).message })
  }

  log('send_current_engine_state', {
    tab_id: tabId, instance_id: instanceId, agents: agents.length,
    has_status: !!status, has_working: !!working, model,
  })

  // Always send the authoritative agent snapshot — including empty. An empty
  // agents: [] is the "drop your stale rows" signal; skipping it is what left
  // iOS reconnects showing ghost agents from sessions ago.
  state.remoteTransport.sendToDevice(deviceId, {
    type: 'desktop_agent_state', tabId, instanceId, agents,
  })
  if (status) {
    state.remoteTransport.sendToDevice(deviceId, {
      type: 'desktop_status', tabId, instanceId, fields: status,
    })
  }
  // Always forward the working message ('' clears a stale banner on resync).
  state.remoteTransport.sendToDevice(deviceId, {
    type: 'desktop_working_message', tabId, instanceId, message: working,
  })
  if (model) {
    state.remoteTransport.sendToDevice(deviceId, {
      type: 'desktop_model_override', tabId, instanceId, model,
    })
  }
}

export async function handleSync(deviceId: string): Promise<void> {
  // Send exactly ONE full snapshot to this device, regardless of the poll
  // gate's hash state. An explicit sync/resync from iOS means it may have
  // missed deltas and is requesting a full state refresh — suppressing it
  // because a hash is unchanged is the very bug that causes the "missed a
  // delta, never re-sent" freeze. sendSync is the single snapshot sender
  // (force semantics) plus the rest of the envelope (engine profiles,
  // settings snapshot, terminal buffers); it updates this device's per-device
  // poll-gate hash so the next tick doesn't immediately re-send. The former
  // second forceSyncSnapshot call here (two full snapshot builds + sends per
  // sync, multiplied by the iOS retry loop) is retired.
  log('handle_sync: forcing single snapshot', { device_id: deviceId })
  await sendSync((event) => state.remoteTransport?.sendToDevice(deviceId, event), [deviceId])
  autoPullDiagnosticLogs(deviceId)
}

export function handleCloseTab(cmd: Extract<RemoteCommand, { type: 'desktop_close_tab' }>): void {
  const tabId = cmd.tabId

  // Same rule the desktop enforces on Cmd+W: refuse the close while the
  // orchestrator, a dispatched agent, or a background bash command is still
  // in flight. Closing anyway stops the engine session and orphans that work,
  // so the phone must not be able to do what the desktop refuses. The guard
  // reads the projected tab states (the cache the iOS snapshot itself is served
  // from) because conversationPanes lives in the renderer.
  const cachedTabs = state.rendererSnapshotCache?.tabs ?? []
  const guard = evaluateRemoteCloseGuard(cachedTabs.find((t) => t.id === tabId))
  if (guard.blocked) {
    // No desktop_tab_closed is sent, so the phone's next snapshot tick restores
    // the row if it removed it optimistically — the snapshot is authoritative
    // for tab existence, exactly as it is for every other tab field.
    warn('close_tab refused: work still in flight', formatRemoteCloseGuardRefusal(tabId, guard))
    return
  }

  sessionPlane.closeTab(tabId)
  terminalManager.destroyByPrefix(`${tabId}:`)
  // Conversations now key their engine session by the bare tabId (ADR-010),
  // so stop that session directly. stopByPrefix(`${tabId}:`) only matches
  // compound keys (terminals, legacy `${tabId}:main` sessions) and would
  // silently leave the bare-key conversation session orphaned in both the
  // desktop activeSessions map and the engine daemon.
  void engineBridge.stopSession(tabId)
  engineBridge.stopByPrefix(`${tabId}:`)
  broadcast(IPC.REMOTE_CLOSE_TAB, tabId)
  state.remoteTransport?.send({ type: 'desktop_tab_closed', tabId })

  // Clean up all per-tab main-process state to prevent memory leaks.
  activeAssistantMessages.delete(tabId)
  lastMessagePreview.delete(tabId)
  lastForwardedTabStatus.delete(tabId)
  clearAgentStateForTab(tabId)
  for (const key of extensionCommandRegistry.keys()) {
    if (key === tabId || key.startsWith(`${tabId}:`)) extensionCommandRegistry.delete(key)
  }
  // Drop the desktop-local clientMsgId↔entryId map for this tab (RC-9).
  clearClientMsgIdsForTab(tabId)
}

export async function handleSetPermissionMode(cmd: Extract<RemoteCommand, { type: 'desktop_set_permission_mode' }>): Promise<void> {
  const mode = cmd.mode
  if (mode !== 'auto' && mode !== 'plan') {
    log('set_permission_mode: invalid mode', { mode })
    return
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
  if (state.mainWindow) {
    try {
      const escapedTab = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const info = await state.mainWindow.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var s = store.getState();
          var tab = s.tabs.find(function(t) { return t.id === '${escapedTab}'; });
          if (!tab) return null;
          var pane = s.conversationPanes.get('${escapedTab}');
          var inst = pane ? (pane.instances.find(function(i) { return i.id === pane.activeInstanceId; }) || pane.instances[0]) : null;
          return {
            isEngine: !!tab.engineProfileId,
            instanceId: pane ? pane.activeInstanceId : null,
            planFilePath: inst ? (inst.planFilePath || null) : null,
          };
        })()
      `)
      if (mode === 'plan' && info?.planFilePath) {
        planFilePath = info.planFilePath
      }
      if (info?.isEngine && info?.instanceId) {
        log('set_permission_mode: engine tab', { key: cmd.tabId, path: planFilePath ?? '' })
        engineBridge.sendSetPlanMode(cmd.tabId, mode === 'plan', undefined, 'remote', undefined, planFilePath)
        routed = true
      }
    } catch (err) {
      log('set_permission_mode: engine tab detection failed', { error: (err as Error).message })
    }
  }

  // CLI tabs (or fallback when engine detection fails)
  if (!routed) {
    sessionPlane.setPermissionMode(cmd.tabId, mode, 'remote', planFilePath)
  }

  // Always broadcast so the UI updates regardless of tab type
  broadcast(IPC.REMOTE_SET_PERMISSION_MODE, { tabId: cmd.tabId, mode })
}

/**
 * Apply a per-conversation thinking-effort change sent from iOS. There is no
 * engine command — thinking is a per-prompt override — so the handler simply
 * broadcasts to the renderer, which writes the level onto the targeted tab /
 * active instance (the same state the desktop's own prompt-submit reads). The
 * next prompt from either client then carries the level. 'off' clears it.
 */
export async function handleSetThinkingEffort(cmd: Extract<RemoteCommand, { type: 'desktop_set_thinking_effort' }>): Promise<void> {
  const effort = cmd.effort
  // Validated against the shared ladder rather than an inline list: an inline
  // list silently rejected 'adaptive' after it was added to the type, dropping
  // the command with only a log line to show for it.
  if (!isThinkingEffort(effort)) {
    log('set_thinking_effort: invalid effort', { effort })
    return
  }
  log('set_thinking_effort', { tab_id: cmd.tabId, effort })
  broadcast(IPC.REMOTE_SET_THINKING_EFFORT, { tabId: cmd.tabId, effort })
}

export async function handleLoadConversation(cmd: Extract<RemoteCommand, { type: 'desktop_load_conversation' }>, deviceId: string): Promise<void> {
  // Coalesce redundant identical reloads (same device, tab, and cursor) that
  // arrive faster than the coalesce window. A flapping iOS client can otherwise
  // fire this 60-120x/sec per conversation and back up the relay send path.
  // Distinct pagination steps advance `before`, so they key differently and pass
  // through. A duplicate is ANSWERED from the cached page where one exists
  // rather than dropped in silence — see the gate module doc.
  const verdict = decideLoad(deviceId, cmd.tabId, cmd.before)
  if (verdict.action === 'drop') return
  if (verdict.action === 'replay') {
    state.remoteTransport?.sendToDevice(deviceId, verdict.event)
    return
  }
  // Send a terminal history response AND cache it, so a duplicate inside the
  // window replays these exact bytes instead of going unanswered. Every exit
  // path below (no-chain, success, error) routes through here.
  const sendHistory = (event: Extract<RemoteEvent, { type: 'desktop_conversation_history' }>): void => {
    recordLoadResponse(deviceId, cmd.tabId, cmd.before, event)
    state.remoteTransport?.sendToDevice(deviceId, event)
  }
  try {
    // History is served from the ENGINE — the same `load_session_history`
    // source the overlay and ATV hydrate from — so every client renders one
    // canonical transcript with the engine's stable row ids. The renderer is
    // consulted only for tab metadata (never message content); the persisted
    // tabs file covers the renderer-unavailable case, and the engine daemon
    // outlives the renderer.
    const chain = await resolveTabSessionChain(cmd.tabId)
    if (!chain) {
      log('load_conversation: no session chain for tab', { tab_id: cmd.tabId })
      sendHistory({ type: 'desktop_conversation_history', tabId: cmd.tabId, messages: [], hasMore: false, before: cmd.before ?? null })
      return
    }

    const history = await engineBridge.loadChainHistory(chain.sessionIds)
    // Shared pure mapper — the exact conversion the overlay uses, so iOS
    // receives identical marker/divider content and canonical row ids.
    // makeId only fires for rows from an engine predating SessionMessage.id.
    let fallbackSeq = 0
    const all = mapSessionHistory(history, () => `hist-${cmd.tabId}-${fallbackSeq++}`)

    const { page, hasMore, cursor, total } = paginateHistory(all, cmd.before)
    log('load_conversation', { tab_id: cmd.tabId, total, page: page.length, has_more: hasMore, sessions: chain.sessionIds.length })

    const msgs = await Promise.all(page.map(toRemoteMessage).map(async (m) => {
      if (m.toolName === 'ExitPlanMode') {
        try {
          const input = m.toolInput ? JSON.parse(m.toolInput) : {}
          if (!input.planContent) {
            // Fallback plan path comes from the loaded transcript itself (the
            // most recent plan-file Write) — same data the old renderer scrape
            // read, without touching the renderer.
            const planPath = (input.planFilePath as string | undefined) || planPathFromHistory(all)
            // Async read off the main thread: readFileSync here blocked the
            // event loop (and the relay send drain) once per ExitPlanMode
            // message per load, in the hot path a flapping client hammers.
            // readFile rejects with ENOENT when the plan file is absent, which
            // is the common case, so treat a read failure as "no plan file".
            let planContent: string | null = null
            if (planPath) {
              try {
                planContent = await readFile(planPath, 'utf-8')
              } catch (err) {
                // ENOENT (plan file absent) is the common case; log at debug so
                // the fallback is observable without noise at higher levels.
                log('remote: plan file read failed; treating as no plan', { path: planPath, error: String(err) })
                planContent = null
              }
            }
            if (planPath && planContent !== null) {
              return { ...m, toolInput: JSON.stringify({ ...input, planFilePath: planPath, planContent }) }
            } else {
              log('load_conversation: no plan file found for ExitPlanMode', { path: planPath })
            }
          }
        } catch (err) {
          log('load_conversation: enrichment error', { error: (err as Error).message })
        }
      }
      return m
    }))

    // Annotate user rows with the desktop-local clientMsgId so iOS can collapse
    // its optimistic bubble against the canonical row by the id it sent, even if
    // the live re-key events were dropped. The engine holds no client id (UI
    // concern); the desktop recorded entryId→clientMsgId when it observed the
    // turn persist. Only user rows carry it; the rest pass through. (RC-9)
    for (const m of msgs) {
      if (m.role === 'user') {
        const cmid = lookupClientMsgId(cmd.tabId, m.id)
        if (cmid) m.clientMsgId = cmid
      }
    }

    sendHistory({
      type: 'desktop_conversation_history',
      tabId: cmd.tabId,
      messages: msgs,
      hasMore,
      cursor,
      // Echo of the REQUEST cursor. iOS discriminates first-page/heal
      // (wholesale replace) from older-page pagination (prepend) on this —
      // never on the response cursor, which is set on every page that has
      // more history (the heal-loop bug this field fixes).
      before: cmd.before ?? null,
    })

    // Additionally push live engine state when the session is running, so iOS
    // immediately has up-to-date agents, status fields, and working message
    // on reconnect. Gate on RUNTIME status — not tab type or extension
    // presence — since any conversation's session may be running.
    if (chain.tabStatus === 'running' || chain.tabStatus === 'connecting') {
      log('load_conversation: session active, pushing live state', { tab_id: cmd.tabId, status: chain.tabStatus })
      await sendCurrentEngineState(cmd.tabId, deviceId)
    }
  } catch (err) {
    log('load_conversation error', { error: (err as Error).message })
    sendHistory({ type: 'desktop_conversation_history', tabId: cmd.tabId, messages: [], hasMore: false, before: cmd.before ?? null })
  }
}

export async function handleDiscoverCommands(cmd: Extract<RemoteCommand, { type: 'desktop_discover_commands' }>, deviceId: string): Promise<void> {
  const { directory } = cmd
  try {
    // The engine OWNS slash resolution + expansion, so it is the authority
    // on which filesystem `.md`/skill templates exist. Ask it via
    // discover_slash_commands instead of walking the filesystem in TS so the
    // iOS autocomplete shows the same list the desktop does. The
    // enableClaudeCompat setting gates whether the engine honors the `.claude`
    // / `~/.claude` roots (commands AND skills); the desktop reads the setting
    // and hands it to the engine (which holds no opinion on it). This keeps the
    // iOS autocomplete consistent with the desktop's IPC.DISCOVER_COMMANDS path.
    //
    // Normalize '~' / empty to an empty working dir so the engine walks only the
    // user-level roots (~/.ion, ~/.claude) and does not treat a literal '~' as a
    // project root. Matches the IPC.DISCOVER_COMMANDS handler. A malformed
    // present path resolves to null → treat as user-only rather than erroring
    // the iOS autocomplete entirely.
    const workingDir = resolveDiscoveryWorkingDir(directory) ?? ''
    const claudeCompat = readClaudeCompat()
    const commands = await engineBridge.discoverSlashCommands(workingDir, claudeCompat)
    log('discover_commands', { count: commands.length, device_id: deviceId, claude_compat: claudeCompat })
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_discover_commands_response', directory, commands })
  } catch (err) {
    log('discover_commands error', { error: (err as Error).message })
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_discover_commands_response', directory, commands: [] })
  }
}
