import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { IPC } from '../../../shared/types'
import { log as _log, warn as _warn } from '../../logger'
import { state, sessionPlane, engineBridge, activeAssistantMessages, lastMessagePreview, lastForwardedTabStatus, extensionCommandRegistry } from '../../state'
import { broadcast } from '../../broadcast'
import { terminalManager } from '../../terminal-manager-instance'
import { readSettings, readClaudeCompat } from '../../settings-store'
import { getRemoteTabStates } from '../snapshot'
import { autoPullDiagnosticLogs } from './diagnostics'
import { sendSync } from './tabs-sync'
import { resolveTabSessionChain, paginateHistory, planPathFromHistory, toRemoteMessage } from './tabs-session-chain'
import { mapSessionHistory } from '../../../shared/session-message-mapper'
import { shouldServeLoad } from './load-conversation-gate'
import { resolveDiscoveryWorkingDir } from '../../ipc-validation'
import { lookupClientMsgId, clearClientMsgIdsForTab } from '../client-msg-id-map'
import type { RemoteCommand } from '../protocol'

export { handlePrompt, handleCancel } from './tabs-prompt'

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
 * Engine contract: `engine_agent_state` is a complete snapshot. The
 * authoritative truth is "what the renderer holds right now" — including
 * the empty case. We forward unconditionally: an empty `agents: []`
 * payload tells the mobile client "drop your stale rows from a previous
 * session." Without this, iOS reconnects show ghost agents from connections
 * ago. See docs/architecture/agent-state.md.
 */
async function sendCurrentEngineState(tabId: string, deviceId: string): Promise<void> {
  if (!state.mainWindow || !state.remoteTransport) return
  const escapedTab = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  try {
    const snapshot = await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        var s = store.getState();
        var pane = s.conversationPanes.get('${escapedTab}');
        var inst = pane ? (pane.instances.find(function(i) { return i.id === pane.activeInstanceId; }) || pane.instances[0]) : null;
        var instId = inst ? inst.id : null;
        var agents = (inst && inst.agentStates) || [];
        var status = (inst && inst.statusFields) || null;
        var key = '${escapedTab}' + (instId ? ':' + instId : '');
        var working = s.engineWorkingMessages.get(key) || '';
        var modelOverride = window.__Ion_resolveEngineModel ? window.__Ion_resolveEngineModel('${escapedTab}') : null;
        return { instId: instId, agents: agents, status: status, working: working, modelOverride: modelOverride };
      })()
    `)
    if (!snapshot) {
      log('send_current_engine_state: no snapshot available', { tab_id: tabId })
      return
    }
    const instanceId: string | null = snapshot.instId ?? null
    const agents = snapshot.agents || []
    log('send_current_engine_state', { tab_id: tabId, instance_id: instanceId, agents: agents.length, has_status: !!snapshot.status, has_working: !!snapshot.working, has_model_override: !!snapshot.modelOverride })

    // Always send the authoritative agent snapshot — including empty.
    state.remoteTransport.sendToDevice(deviceId, {
      type: 'desktop_agent_state', tabId, instanceId, agents,
    })
    if (snapshot.status) {
      state.remoteTransport.sendToDevice(deviceId, {
        type: 'desktop_status', tabId, instanceId, fields: snapshot.status,
      })
    }
    // Always forward working message (use '' to clear stale banner on resync).
    state.remoteTransport.sendToDevice(deviceId, {
      type: 'desktop_working_message', tabId, instanceId, message: snapshot.working || '',
    })
    if (snapshot.modelOverride) {
      state.remoteTransport.sendToDevice(deviceId, {
        type: 'desktop_model_override', tabId, instanceId, model: snapshot.modelOverride,
      })
    }
  } catch (err) {
    log('send_current_engine_state error', { error: (err as Error).message })
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

async function createTabFromCommand(
  cmd: { workingDirectory?: string },
  storeMethod: string,
  defaultArgs: string[] = [],
): Promise<string | null> {
  let dir = cmd.workingDirectory
  if (!dir) {
    const s = readSettings()
    dir = s.defaultBaseDirectory || homedir() || ''
  }
  if (!dir) return null
  try {
    const escaped = dir.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const args = ["'" + escaped + "'", ...defaultArgs].join(', ')
    // The store creators (createTabInDirectory / createTerminalTab) are async.
    // await INSIDE the IIFE so the activeTabId restore runs after the tab id is
    // minted rather than racing the unresolved promise; executeJavaScript
    // resolves the returned promise to the string id.
    const tabId = await state.mainWindow?.webContents.executeJavaScript(`
      (async function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        var prev = store.getState().activeTabId;
        var id = await store.getState().${storeMethod}(${args});
        store.setState({ activeTabId: prev });
        return id;
      })()
    `)
    return tabId || null
  } catch (err) {
    log('store_method error', { error: (err as Error).message })
    return null
  }
}

function notifyTabCreated(tabId: string, clientCmdId?: string): void {
  setTimeout(async () => {
    try {
      const { tabs } = await getRemoteTabStates()
      const newTab = tabs.find((t: any) => t.id === tabId)
      if (newTab) state.remoteTransport?.send({ type: 'desktop_tab_created', tab: newTab, clientCmdId })
    } catch (err) {
      // If this echo never sends, iOS's confirm-or-resend loop resends the
      // create command indefinitely with no desktop-side explanation. Log it.
      warn('remote: tab_created notify failed', { tab_id: tabId, error: String(err) })
    }
  }, 500)
}

// Idempotency for the iOS confirm-or-resend loop. iOS attaches a `clientCmdId`
// to each create command and resends it if no `desktop_tab_created` echo comes
// back (its transport can silently wedge after a background/resume cycle, so a
// locally-successful send is not proof of delivery). Without dedup a resend of
// a create that actually landed would spawn a duplicate tab. We remember the
// clientCmdId→tabId mapping and, on a repeat, re-emit the existing tab instead
// of creating another. Bounded FIFO so the map can't grow unbounded across a
// long-lived desktop session.
const recentCreatesByClientCmdId = new Map<string, string>()
const RECENT_CREATES_CAP = 256

function rememberCreate(clientCmdId: string, tabId: string): void {
  recentCreatesByClientCmdId.set(clientCmdId, tabId)
  while (recentCreatesByClientCmdId.size > RECENT_CREATES_CAP) {
    const oldest = recentCreatesByClientCmdId.keys().next().value
    if (oldest === undefined) break
    recentCreatesByClientCmdId.delete(oldest)
  }
}

// Returns true if this is a duplicate delivery of a create we already served.
// On a duplicate we re-emit the created tab (the client's confirmation was
// lost, not its request) and the caller returns without creating a new tab.
function handleDuplicateCreate(clientCmdId: string | undefined): boolean {
  if (!clientCmdId) return false
  const existing = recentCreatesByClientCmdId.get(clientCmdId)
  if (!existing) return false
  log('handle_create_tab: duplicate clientCmdId, re-emitting existing tab', { client_cmd_id: clientCmdId, tab_id: existing })
  notifyTabCreated(existing, clientCmdId)
  return true
}

export async function handleCreateTab(cmd: Extract<RemoteCommand, { type: 'desktop_create_tab' }>): Promise<void> {
  // Idempotency: a resend of a create we already served re-emits the existing
  // tab rather than making a duplicate. See handleDuplicateCreate.
  if (handleDuplicateCreate(cmd.clientCmdId)) return

  // When profileId is present the iOS client wants an extension-hosted
  // conversation. Route through createConversationTab with profileId in opts.
  // When absent, create a plain CLI tab.
  if (cmd.profileId) {
    let dir = cmd.workingDirectory
    if (!dir) {
      const s = readSettings()
      dir = s.defaultBaseDirectory || homedir() || ''
    }
    if (!dir) return
    try {
      const escaped = dir.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const profileArg = `'${cmd.profileId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
      log('handle_create_tab: extension tab', { profile_id: cmd.profileId })
      // createConversationTab is async; await it INSIDE the IIFE so the
      // activeTabId restore runs AFTER the real tab id is minted, not before
      // the promise resolves. executeJavaScript resolves the returned promise.
      const tabId = await state.mainWindow?.webContents.executeJavaScript(`
        (async function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var prev = store.getState().activeTabId;
          var id = await store.getState().createConversationTab('${escaped}', { profileId: ${profileArg} });
          store.setState({ activeTabId: prev });
          return id;
        })()
      `)
      if (tabId) {
        if (cmd.clientCmdId) rememberCreate(cmd.clientCmdId, tabId)
        notifyTabCreated(tabId, cmd.clientCmdId)
      }
    } catch (err) {
      log('handle_create_tab: engine error', { error: (err as Error).message })
    }
    return
  }

  // Plain CLI tab (legacy path).
  // When the iOS client requests pinning into a specific group (e.g. the
  // per-group "+" button next to a group header), forward the group id as
  // the 4th positional argument to createTabInDirectory. The renderer-side
  // store action treats this as an explicit pin and sets groupPinned=true
  // from the start so the first sendMessage's auto-movement skips this tab.
  // We single-quote the group id (matching how `dir` is escaped above) so
  // the value flows safely through executeJavaScript.
  const defaultArgs: string[] = ['false', 'true']
  if (cmd.pinToGroupId) {
    const escaped = cmd.pinToGroupId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    defaultArgs.push("'" + escaped + "'")
    log('handle_create_tab: pinToGroupId, forwarding as explicit-pin', { pin_to_group: cmd.pinToGroupId })
  } else {
    log('handleCreateTab: no pinToGroupId (default-group placement)')
  }
  const tabId = await createTabFromCommand(cmd, 'createTabInDirectory', defaultArgs)
  if (tabId) {
    if (cmd.clientCmdId) rememberCreate(cmd.clientCmdId, tabId)
    notifyTabCreated(tabId, cmd.clientCmdId)
  }
}

export async function handleCreateTerminalTab(cmd: Extract<RemoteCommand, { type: 'desktop_create_terminal_tab' }>): Promise<void> {
  // Idempotency: a resend re-emits the existing terminal tab, not a duplicate.
  if (handleDuplicateCreate(cmd.clientCmdId)) return
  const tabId = await createTabFromCommand(cmd, 'createTerminalTab')
  if (tabId) {
    // Eagerly create a terminal instance + PTY so remote clients can use it
    // without waiting for the desktop renderer to navigate to this tab.
    try {
      const escaped = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const instance = await state.mainWindow?.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var id = store.getState().addTerminalInstance('${escaped}', 'user');
          var pane = store.getState().terminalPanes.get('${escaped}');
          if (!pane) return null;
          var inst = pane.instances.find(function(i) { return i.id === id; });
          if (!inst) return null;
          return { id: inst.id, label: inst.label, kind: inst.kind, cwd: inst.cwd || '' };
        })()
      `)
      if (instance) {
        const key = `${tabId}:${instance.id}`
        terminalManager.create(key, instance.cwd || cmd.workingDirectory || '~')
        state.remoteTransport?.send({
          type: 'desktop_terminal_instance_added',
          tabId,
          instance: { id: instance.id, label: instance.label || 'Shell', kind: instance.kind || 'user', readOnly: false, cwd: instance.cwd || '' },
        })
      }
    } catch (err) {
      log('create_terminal_tab: instance creation error', { error: (err as Error).message })
    }
    if (cmd.clientCmdId) rememberCreate(cmd.clientCmdId, tabId)
    notifyTabCreated(tabId, cmd.clientCmdId)
  }
}

export function handleCloseTab(cmd: Extract<RemoteCommand, { type: 'desktop_close_tab' }>): void {
  const tabId = cmd.tabId
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
  if (effort !== 'off' && effort !== 'low' && effort !== 'medium' && effort !== 'high') {
    log('set_thinking_effort: invalid effort', { effort })
    return
  }
  log('set_thinking_effort', { tab_id: cmd.tabId, effort })
  broadcast(IPC.REMOTE_SET_THINKING_EFFORT, { tabId: cmd.tabId, effort })
}

export async function handleLoadConversation(cmd: Extract<RemoteCommand, { type: 'desktop_load_conversation' }>, deviceId: string): Promise<void> {
  // Drop redundant identical reloads (same device, tab, and cursor) that arrive
  // faster than the coalesce window. A flapping iOS client can otherwise fire
  // this 60-120x/sec per conversation and back up the relay send path. Distinct
  // pagination steps advance `before`, so they key differently and pass through.
  if (!shouldServeLoad(deviceId, cmd.tabId, cmd.before)) return
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
      state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_conversation_history', tabId: cmd.tabId, messages: [], hasMore: false, before: cmd.before ?? null })
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

    state.remoteTransport?.sendToDevice(deviceId, {
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
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_conversation_history', tabId: cmd.tabId, messages: [], hasMore: false, before: cmd.before ?? null })
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

export async function handleSetTabModel(cmd: Extract<RemoteCommand, { type: 'desktop_set_tab_model' }>): Promise<void> {
  try {
    const escapedTab = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedModel = cmd.model.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return;
        store.getState().setTabModel('${escapedTab}', '${escapedModel}');
      })()
    `)
  } catch (err) {
    log('set_tab_model error: ' + (err as Error).message)
  }
}

export async function handleSetPreferredModel(cmd: Extract<RemoteCommand, { type: 'desktop_set_preferred_model' }>): Promise<void> {
  try {
    const escapedModel = cmd.model.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var prefs = window.__Ion_PREFS_STORE__;
        if (!prefs) return;
        prefs.getState().setPreferredModel('${escapedModel}');
      })()
    `)
  } catch (err) {
    log('set_preferred_model error: ' + (err as Error).message)
  }
}

export async function handleSetEngineDefaultModel(cmd: Extract<RemoteCommand, { type: 'desktop_set_engine_default_model' }>): Promise<void> {
  try {
    const escapedModel = cmd.model.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var prefs = window.__Ion_PREFS_STORE__;
        if (!prefs) return;
        prefs.getState().setEngineDefaultModel('${escapedModel}');
      })()
    `)
  } catch (err) {
    log('set_engine_default_model error: ' + (err as Error).message)
  }
}
