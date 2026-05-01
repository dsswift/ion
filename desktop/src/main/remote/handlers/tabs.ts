import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { IPC } from '../../../shared/types'
import { log as _log } from '../../logger'
import { state, sessionPlane, engineBridge } from '../../state'
import { broadcast } from '../../broadcast'
import { terminalManager } from '../../terminal-manager-instance'
import { readSettings } from '../../settings-store'
import { getRemoteTabStates } from '../snapshot'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

export async function handleSync(): Promise<void> {
  const tabs = await getRemoteTabStates()
  const syncSettings = readSettings()
  const recentDirectories: string[] = Array.isArray(syncSettings.recentBaseDirectories) ? syncSettings.recentBaseDirectories : []
  state.remoteTransport?.send({ type: 'snapshot', tabs, recentDirectories })
  const engineProfiles = Array.isArray(syncSettings.engineProfiles) ? syncSettings.engineProfiles : []
  state.remoteTransport?.send({ type: 'engine_profiles', profiles: engineProfiles })
  for (const tab of tabs) {
    if (tab.isTerminalOnly && tab.terminalInstances && tab.terminalInstances.length > 0) {
      try {
        const escapedTabId = tab.id.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
        const buffers: Record<string, string> = await state.mainWindow?.webContents.executeJavaScript(`
          (function() {
            try {
              var store = window.__Ion_SESSION_STORE__;
              if (!store) return {};
              var pane = store.getState().terminalPanes.get('${escapedTabId}');
              if (!pane) return {};
              var result = {};
              for (var i = 0; i < pane.instances.length; i++) {
                var key = '${escapedTabId}:' + pane.instances[i].id;
                var buf = window.__serializeTerminalBuffer ? window.__serializeTerminalBuffer(key) : null;
                if (buf) result[pane.instances[i].id] = buf;
              }
              return result;
            } catch(e) { return {}; }
          })()
        `) || {}
        state.remoteTransport?.send({
          type: 'terminal_snapshot',
          tabId: tab.id,
          instances: tab.terminalInstances,
          activeInstanceId: tab.activeTerminalInstanceId || null,
          buffers: Object.keys(buffers).length > 0 ? buffers : undefined,
        })
      } catch {}
    }
  }
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
        return store.getState().${storeMethod}(${args});
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
      const tabs = await getRemoteTabStates()
      const newTab = tabs.find(t => t.id === tabId)
      if (newTab) state.remoteTransport?.send({ type: 'tab_created', tab: newTab })
    } catch {}
  }, 500)
}

export async function handleCreateTab(cmd: Extract<RemoteCommand, { type: 'create_tab' }>): Promise<void> {
  const tabId = await createTabFromCommand(cmd, 'createTabInDirectory', ['false', 'true'])
  if (tabId) notifyTabCreated(tabId)
}

export async function handleCreateTerminalTab(cmd: Extract<RemoteCommand, { type: 'create_terminal_tab' }>): Promise<void> {
  const tabId = await createTabFromCommand(cmd, 'createTerminalTab')
  if (tabId) notifyTabCreated(tabId)
}

export async function handleCreateEngineTab(cmd: Extract<RemoteCommand, { type: 'create_engine_tab' }>): Promise<void> {
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
        return store.getState().createEngineTab('${escaped}', ${profileArg});
      })()
    `)
    if (tabId) notifyTabCreated(tabId)
  } catch (err) {
    log(`create_engine_tab error: ${(err as Error).message}`)
  }
}

export function handleCloseTab(cmd: Extract<RemoteCommand, { type: 'close_tab' }>): void {
  sessionPlane.closeTab(cmd.tabId)
  terminalManager.destroyByPrefix(`${cmd.tabId}:`)
  broadcast(IPC.REMOTE_CLOSE_TAB, cmd.tabId)
  state.remoteTransport?.send({ type: 'tab_closed', tabId: cmd.tabId })
}

export function handlePrompt(cmd: Extract<RemoteCommand, { type: 'prompt' }>): void {
  const reqId = `remote-${Date.now()}`
  const promptText = cmd.text.trim()
    .replace(/—/g, '--')
    .replace(/–/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')

  if (promptText.startsWith('!') && promptText.length > 1) {
    const bashCmd = promptText.substring(1).trim()
    if (!bashCmd) return

    state.remoteTransport?.send({
      type: 'message_added',
      tabId: cmd.tabId,
      message: { id: reqId, role: 'user', content: `! ${bashCmd}`, timestamp: Date.now(), source: 'remote' },
    })
    broadcast(IPC.REMOTE_BASH_COMMAND, { tabId: cmd.tabId, command: bashCmd })
    return
  }

  const now = Date.now()
  state.remoteTransport?.send({
    type: 'message_added',
    tabId: cmd.tabId,
    message: { id: reqId, role: 'user', content: promptText, timestamp: now, source: 'remote' },
  })
  broadcast(IPC.REMOTE_USER_MESSAGE, { tabId: cmd.tabId, requestId: reqId, prompt: promptText, timestamp: now })
}

export function handleCancel(cmd: Extract<RemoteCommand, { type: 'cancel' }>): void {
  if (!sessionPlane.cancelTab(cmd.tabId)) {
    log(`remote cancel: tab ${cmd.tabId} not in sessionPlane, sending abort directly`)
    engineBridge.sendAbort(cmd.tabId)
  }
}

export function handleSetPermissionMode(cmd: Extract<RemoteCommand, { type: 'set_permission_mode' }>): void {
  const mode = cmd.mode
  if (mode !== 'auto' && mode !== 'plan') {
    log(`Remote set_permission_mode: invalid mode "${mode}"`)
    return
  }
  log(`Remote set_permission_mode: tab=${cmd.tabId} mode=${mode}`)
  sessionPlane.setPermissionMode(cmd.tabId, mode)
  broadcast(IPC.REMOTE_SET_PERMISSION_MODE, { tabId: cmd.tabId, mode })
}

export async function handleLoadConversation(cmd: Extract<RemoteCommand, { type: 'load_conversation' }>): Promise<void> {
  const PAGE_SIZE = 10
  try {
    if (!state.mainWindow) {
      log(`load_conversation: mainWindow not available`)
      state.remoteTransport?.send({ type: 'conversation_history', tabId: cmd.tabId, messages: [], hasMore: false })
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
          var all = tab.messages || [];
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
          var page = all.slice(startIdx, endIdx).map(function(m) {
            var content = m.content || '';
            if (m.role === 'tool' && content.length > 2048) content = content.substring(0, 2048) + '\\n... [truncated]';
            else if (content.length > 10000) content = content.substring(0, 10000);
            return {
              id: m.id, role: m.role, content: content,
              toolName: m.toolName, toolInput: m.toolInput,
              toolId: m.toolId, toolStatus: m.toolStatus,
              timestamp: m.timestamp,
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
                    var msgs = tab.messages || [];
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

    state.remoteTransport?.send({
      type: 'conversation_history',
      tabId: cmd.tabId,
      messages: msgs,
      hasMore: result.hasMore || false,
      cursor: result.cursor,
    })
  } catch (err) {
    log(`load_conversation error: ${(err as Error).message}`)
    state.remoteTransport?.send({ type: 'conversation_history', tabId: cmd.tabId, messages: [], hasMore: false })
  }
}
