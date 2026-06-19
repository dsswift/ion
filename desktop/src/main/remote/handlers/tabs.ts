import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { IPC } from '../../../shared/types'
import { log as _log } from '../../logger'
import { state, sessionPlane, engineBridge, activeAssistantMessages, activeToolInputs, lastMessagePreview, lastForwardedEngineTabStatus, extensionCommandRegistry } from '../../state'
import { broadcast } from '../../broadcast'
import { terminalManager } from '../../terminal-manager-instance'
import { readSettings, readClaudeCompat } from '../../settings-store'
import { getRemoteTabStates } from '../snapshot'
import { autoPullDiagnosticLogs } from './diagnostics'
import { broadcastSync, sendSync } from './tabs-sync'
import { processIncomingPrompt } from '../../prompt-pipeline'
import { resolveDiscoveryWorkingDir } from '../../ipc-validation'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

export async function handleSync(deviceId: string): Promise<void> {
  await sendSync((event) => state.remoteTransport?.sendToDevice(deviceId, event))
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
    const tabId = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        var prev = store.getState().activeTabId;
        var id = store.getState().${storeMethod}(${args});
        store.setState({ activeTabId: prev });
        return id;
      })()
    `)
    return tabId || null
  } catch (err) {
    log(`${storeMethod} error: ${(err as Error).message}`)
    return null
  }
}

function notifyTabCreated(tabId: string): void {
  setTimeout(async () => {
    try {
      const { tabs } = await getRemoteTabStates()
      const newTab = tabs.find((t: any) => t.id === tabId)
      if (newTab) state.remoteTransport?.send({ type: 'desktop_tab_created', tab: newTab })
    } catch {}
  }, 500)
}

export async function handleCreateTab(cmd: Extract<RemoteCommand, { type: 'desktop_create_tab' }>): Promise<void> {
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
    log(`handleCreateTab: pinToGroupId=${cmd.pinToGroupId} (forwarding to createTabInDirectory as explicit-pin)`)
  } else {
    log('handleCreateTab: no pinToGroupId (default-group placement)')
  }
  const tabId = await createTabFromCommand(cmd, 'createTabInDirectory', defaultArgs)
  if (tabId) notifyTabCreated(tabId)
}

export async function handleCreateTerminalTab(cmd: Extract<RemoteCommand, { type: 'desktop_create_terminal_tab' }>): Promise<void> {
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
      log(`create_terminal_tab: instance creation error: ${(err as Error).message}`)
    }
    notifyTabCreated(tabId)
  }
}

export async function handleCreateEngineTab(cmd: Extract<RemoteCommand, { type: 'desktop_create_engine_tab' }>): Promise<void> {
  let dir = cmd.workingDirectory
  if (!dir) {
    const s = readSettings()
    dir = s.defaultBaseDirectory || homedir() || ''
  }
  if (!dir) return
  try {
    const escaped = dir.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const profileArg = cmd.profileId ? `'${cmd.profileId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : 'undefined'
    const tabId = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        var prev = store.getState().activeTabId;
        var id = store.getState().createEngineTab('${escaped}', ${profileArg});
        store.setState({ activeTabId: prev });
        return id;
      })()
    `)
    if (tabId) notifyTabCreated(tabId)
  } catch (err) {
    log(`create_engine_tab error: ${(err as Error).message}`)
  }
}

export function handleCloseTab(cmd: Extract<RemoteCommand, { type: 'desktop_close_tab' }>): void {
  const tabId = cmd.tabId
  sessionPlane.closeTab(tabId)
  terminalManager.destroyByPrefix(`${tabId}:`)
  engineBridge.stopByPrefix(`${tabId}:`)
  broadcast(IPC.REMOTE_CLOSE_TAB, tabId)
  state.remoteTransport?.send({ type: 'desktop_tab_closed', tabId })

  // Clean up all per-tab main-process state to prevent memory leaks.
  activeAssistantMessages.delete(tabId)
  activeToolInputs.delete(tabId)
  lastMessagePreview.delete(tabId)
  lastForwardedEngineTabStatus.delete(tabId)
  for (const key of extensionCommandRegistry.keys()) {
    if (key === tabId || key.startsWith(`${tabId}:`)) extensionCommandRegistry.delete(key)
  }
}

/**
 * Resolve the working directory the renderer has stored for a given tab.
 * Used by handlePrompt to feed the unified prompt pipeline a projectPath
 * for `.md` template expansion — without it, `.md` lookup would only
 * search `~/.claude/commands/` and miss project-scoped commands at
 * `${cwd}/.claude/commands/`. Returns undefined when the tab isn't found
 * or mainWindow isn't ready (defensive — in that case the pipeline still
 * runs, just without project-scoped `.md` discovery).
 */
async function resolveTabProjectPath(tabId: string): Promise<string | undefined> {
  if (!state.mainWindow) return undefined
  try {
    const escapedTab = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const cwd = await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        var tab = store.getState().tabs.find(function(t) { return t.id === '${escapedTab}'; });
        return tab && tab.workingDirectory ? tab.workingDirectory : null;
      })()
    `)
    return cwd || undefined
  } catch (err) {
    log(`resolveTabProjectPath: error tab=${tabId}: ${(err as Error).message}`)
    return undefined
  }
}

export async function handlePrompt(cmd: Extract<RemoteCommand, { type: 'desktop_prompt' }>): Promise<void> {
  const reqId = cmd.clientMsgId || `remote-${Date.now()}`
  // Echo the user's typed text back to iOS with a canonical ms timestamp so
  // iOS replaces its optimistic entry by id (fixing the "56 years ago"
  // symptom that motivated the pipeline refactor). For non-slash text the
  // pipeline still goes through this echo before broadcasting to the
  // renderer; for slash text the pipeline handles the echo itself in
  // handleSlash().
  //
  // We do the echo here UNCONDITIONALLY for normal prompts because the
  // pipeline only echoes from handleSlash() (and from clearConnectingStatus
  // for terminal command outcomes). The redundancy is intentional: a normal
  // remote prompt has no "command outcome" event to anchor an echo on, so
  // we echo at the entry point. Slash echoes inside the pipeline are extra
  // confirmations, not the only ones — but for the non-slash path this
  // echo is the only one.
  state.remoteTransport?.send({
    type: 'desktop_message_added',
    tabId: cmd.tabId,
    message: { id: reqId, role: 'user', content: cmd.text, timestamp: Date.now(), source: 'remote' },
  })
  // Resolve the tab's working directory from the renderer store so the
  // pipeline can find project-scoped `.md` templates (e.g.
  // ${cwd}/.claude/commands/ion--review-changes.md). The renderer is the
  // authoritative source for per-tab cwd; sessionPlane only stores it
  // implicitly via the most recent submitPrompt. Awaiting this query is
  // cheap (single executeJavaScript round-trip) and the work-in-flight
  // overlap with the engine dispatch is unavoidable anyway.
  const projectPath = await resolveTabProjectPath(cmd.tabId)
  // Fire-and-forget the unified pipeline. Errors are logged inside the
  // pipeline; we never want a thrown error here to crash the transport.
  void processIncomingPrompt({
    tabId: cmd.tabId,
    text: cmd.text,
    attachments: cmd.attachments,
    reqId,
    source: 'remote',
    isEngineTab: false,
    projectPath,
    implementationPhase: cmd.implementationPhase,
  }).catch((err: unknown) => {
    log(`handlePrompt: pipeline error: ${(err as Error).message}`)
  })
}

export function handleCancel(cmd: Extract<RemoteCommand, { type: 'desktop_cancel' }>): void {
  if (!sessionPlane.cancelTab(cmd.tabId)) {
    log(`remote cancel: tab ${cmd.tabId} not in sessionPlane, sending abort directly`)
    engineBridge.sendAbort(cmd.tabId)
  }
}

export async function handleSetPermissionMode(cmd: Extract<RemoteCommand, { type: 'desktop_set_permission_mode' }>): Promise<void> {
  const mode = cmd.mode
  if (mode !== 'auto' && mode !== 'plan') {
    log(`Remote set_permission_mode: invalid mode "${mode}"`)
    return
  }
  log(`Remote set_permission_mode: tab=${cmd.tabId} mode=${mode}`)

  // Engine tabs are keyed by `tabId:instanceId` in the engine.
  // The generic sessionPlane.setPermissionMode uses bare tabId which
  // silently misses the engine session. Detect engine tabs and route
  // through the compound-key bridge path.
  let routed = false
  if (state.mainWindow) {
    try {
      const escapedTab = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const info = await state.mainWindow.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var s = store.getState();
          var tab = s.tabs.find(function(t) { return t.id === '${escapedTab}'; });
          if (!tab || !tab.hasEngineExtension) return null;
          var pane = s.conversationPanes.get('${escapedTab}');
          if (!pane || !pane.activeInstanceId) return null;
          return { instanceId: pane.activeInstanceId };
        })()
      `)
      if (info?.instanceId) {
        const compoundKey = `${cmd.tabId}:${info.instanceId}`
        log(`Remote set_permission_mode: engine tab, using compound key=${compoundKey}`)
        engineBridge.sendSetPlanMode(compoundKey, mode === 'plan', undefined, 'remote')
        routed = true
      }
    } catch (err) {
      log(`Remote set_permission_mode: engine tab detection failed: ${(err as Error).message}`)
    }
  }

  // CLI tabs (or fallback when engine detection fails)
  if (!routed) {
    sessionPlane.setPermissionMode(cmd.tabId, mode)
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
    log(`Remote set_thinking_effort: invalid effort "${effort}"`)
    return
  }
  log(`Remote set_thinking_effort: tab=${cmd.tabId} effort=${effort}`)
  broadcast(IPC.REMOTE_SET_THINKING_EFFORT, { tabId: cmd.tabId, effort })
}

export async function handleLoadConversation(cmd: Extract<RemoteCommand, { type: 'desktop_load_conversation' }>, deviceId: string): Promise<void> {
  const PAGE_SIZE = 10
  try {
    if (!state.mainWindow) {
      log(`load_conversation: mainWindow not available`)
      state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_conversation_history', tabId: cmd.tabId, messages: [], hasMore: false })
      return
    }

    const escapedTabId = cmd.tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const escapedBefore = cmd.before ? cmd.before.replace(/\\/g, '\\\\').replace(/'/g, "\\'") : ''

    const result = await state.mainWindow.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return { messages: [], hasMore: false };
          var s = store.getState();
          var tab = s.tabs.find(function(t) { return t.id === '${escapedTabId}'; });
          if (!tab) return { messages: [], hasMore: false };
          // Messages live on the active conversation instance for every tab.
          var hPane = s.conversationPanes ? s.conversationPanes.get('${escapedTabId}') : null;
          var hInst = hPane ? (hPane.instances.find(function(i){ return i.id === hPane.activeInstanceId; }) || hPane.instances[0]) : null;
          var all = (hInst && hInst.messages) || [];
          var total = all.length;
          var pageSize = ${PAGE_SIZE};
          var before = '${escapedBefore}';
          var startIdx = 0;
          var endIdx = total;
          if (before) {
            var cursorIdx = all.findIndex(function(m) { return m.id === before; });
            if (cursorIdx > 0) {
              endIdx = cursorIdx;
              startIdx = Math.max(0, endIdx - pageSize);
            }
          } else {
            startIdx = Math.max(0, total - pageSize);
          }
          // Snap startIdx backward to a turn boundary (user message) to avoid
          // sending partial turns/tool-groups to iOS
          while (startIdx > 0 && all[startIdx] && all[startIdx].role !== 'user') {
            startIdx--;
          }
          var page = all.slice(startIdx, endIdx).map(function(m) {
            var content = m.content || '';
            if (m.role === 'tool' && content.length > 2048) content = content.substring(0, 2048) + '\\n... [truncated]';
            return {
              id: m.id, role: m.role, content: content,
              toolName: m.toolName, toolInput: m.toolInput,
              toolId: m.toolId, toolStatus: m.toolStatus,
              timestamp: m.timestamp,
              // Slash-command provenance from the engine SessionMessage, so iOS
              // renders the command pill for resolved slash invocations.
              slashCommand: m.slashCommand, slashArgs: m.slashArgs, slashSource: m.slashSource,
              attachments: (m.attachments || []).map(function(a) {
                return { id: a.id, type: a.type, name: a.name, path: a.path };
              }),
            };
          });
          var hasMore = startIdx > 0;
          var cursor = hasMore && page.length > 0 ? page[0].id : undefined;
          return { messages: page, hasMore: hasMore, cursor: cursor, total: total };
        } catch(e) { return { messages: [], hasMore: false }; }
      })()
    `) || { messages: [], hasMore: false }

    log(`load_conversation: tab=${cmd.tabId} total=${result.total || '?'} page=${result.messages?.length || 0} hasMore=${result.hasMore}`)

    const msgs = await Promise.all((result.messages || []).map(async (m: any) => {
      if (m.toolName === 'ExitPlanMode') {
        try {
          const input = m.toolInput ? JSON.parse(m.toolInput) : {}
          if (!input.planContent) {
            let planPath = input.planFilePath as string | undefined
            if (!planPath && state.mainWindow) {
              try {
                planPath = await state.mainWindow.webContents.executeJavaScript(`
                  (function() {
                    var store = window.__Ion_SESSION_STORE__;
                    if (!store) return null;
                    var tab = store.getState().tabs.find(function(t) { return t.id === '${escapedTabId}'; });
                    if (!tab) return null;
                    var st2 = store.getState();
                    var pPane = st2.conversationPanes ? st2.conversationPanes.get('${escapedTabId}') : null;
                    var pInst = pPane ? (pPane.instances.find(function(i){ return i.id === pPane.activeInstanceId; }) || pPane.instances[0]) : null;
                    var msgs = (pInst && pInst.messages) || [];
                    for (var i = msgs.length - 1; i >= 0; i--) {
                      var m = msgs[i];
                      if (m.toolName === 'Write' && m.toolInput) {
                        try {
                          var input = JSON.parse(m.toolInput);
                          var fp = input.file_path;
                          if (fp && /\\/\\.ion\\/plans\\/[^/]+\\.md$/.test(fp)) return fp;
                        } catch(e) {}
                      }
                    }
                    // Fallback: check the instance's permissionDenied for planFilePath
                    var denied = pInst && pInst.permissionDenied && pInst.permissionDenied.tools;
                    if (denied) {
                      for (var d = 0; d < denied.length; d++) {
                        if (denied[d].toolName === 'ExitPlanMode' && denied[d].toolInput && denied[d].toolInput.planFilePath) {
                          return denied[d].toolInput.planFilePath;
                        }
                      }
                    }
                    return null;
                  })()
                `) || undefined
              } catch {}
            }
            if (planPath && existsSync(planPath)) {
              const content = readFileSync(planPath, 'utf-8')
              return { ...m, toolInput: JSON.stringify({ ...input, planFilePath: planPath, planContent: content }) }
            } else {
              log(`load_conversation: no plan file found for ExitPlanMode (planPath=${planPath})`)
            }
          }
        } catch (err) {
          log(`load_conversation: enrichment error: ${(err as Error).message}`)
        }
      }
      return m
    }))

    state.remoteTransport?.sendToDevice(deviceId, {
      type: 'desktop_conversation_history',
      tabId: cmd.tabId,
      messages: msgs,
      hasMore: result.hasMore || false,
      cursor: result.cursor,
    })
  } catch (err) {
    log(`load_conversation error: ${(err as Error).message}`)
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_conversation_history', tabId: cmd.tabId, messages: [], hasMore: false })
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
    log(`discover_commands: engine returned ${commands.length} entries (device=${deviceId}, claudeCompat=${claudeCompat})`)
    state.remoteTransport?.sendToDevice(deviceId, { type: 'desktop_discover_commands_response', directory, commands })
  } catch (err) {
    log(`discover_commands error: ${(err as Error).message}`)
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
