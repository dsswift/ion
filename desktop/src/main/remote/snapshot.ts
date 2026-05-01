import { existsSync, readFileSync } from 'fs'
import { state, sessionPlane, lastMessagePreview } from '../state'
import { TABS_FILE } from '../settings-store'
import type { RemoteTabState } from './protocol'
import type { TabStatus } from '../../shared/types'

export async function getRemoteTabStates(): Promise<RemoteTabState[]> {
  let rendererTabs: any[] = []
  try {
    rendererTabs = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return [];
          var s = store.getState();
          var panes = s.terminalPanes;
          return s.tabs.map(function(t) {
            var msgs = t.messages || [];
            var lastMsg = null;
            var lastTs = 0;
            for (var i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'assistant' || msgs[i].role === 'user') {
                lastMsg = (msgs[i].content || '').substring(0, 100);
                lastTs = msgs[i].timestamp || 0;
                break;
              }
            }
            var queue = (t.permissionQueue || []).slice();
            if (t.status !== 'failed' && t.status !== 'dead') {
              var denied = t.permissionDenied && t.permissionDenied.tools;
              if (denied && denied.length > 0) {
                for (var d = 0; d < denied.length; d++) {
                  if (t.status === 'completed' &&
                      denied[d].toolName !== 'ExitPlanMode' &&
                      denied[d].toolName !== 'AskUserQuestion') continue;
                  queue.push({
                    questionId: 'denied-' + denied[d].toolUseId,
                    toolTitle: denied[d].toolName,
                    toolInput: denied[d].toolInput,
                    options: [],
                  });
                }
              }
            }
            var pane = panes && panes.get ? panes.get(t.id) : null;
            var terminalInstances = undefined;
            var activeTerminalInstanceId = undefined;
            if (pane && pane.instances && pane.instances.length > 0) {
              terminalInstances = pane.instances.map(function(inst) {
                return { id: inst.id, label: inst.label || 'Shell', kind: inst.kind || 'user', readOnly: !!inst.readOnly, cwd: inst.cwd || t.workingDirectory };
              });
              activeTerminalInstanceId = pane.activeInstanceId || pane.instances[0].id;
            }
            var ePanes = s.enginePanes;
            var ePane = ePanes && ePanes.get ? ePanes.get(t.id) : null;
            var engineInstances = undefined;
            var activeEngineInstanceId = undefined;
            if (ePane && ePane.instances && ePane.instances.length > 0) {
              engineInstances = ePane.instances.map(function(inst) {
                return { id: inst.id, label: inst.label };
              });
              activeEngineInstanceId = ePane.activeInstanceId || ePane.instances[0].id;
            }
            return {
              id: t.id,
              title: t.title,
              customTitle: t.customTitle,
              status: t.status,
              workingDirectory: t.workingDirectory,
              permissionMode: t.permissionMode,
              permissionQueue: queue,
              contextTokens: t.contextTokens,
              messageCount: msgs.length,
              queuedPrompts: t.queuedPrompts || [],
              isTerminalOnly: t.isTerminalOnly || undefined,
              isEngine: t.isEngine || undefined,
              engineInstances: engineInstances,
              activeEngineInstanceId: activeEngineInstanceId,
              terminalInstances: terminalInstances,
              activeTerminalInstanceId: activeTerminalInstanceId,
              lastMessageContent: lastMsg,
              lastActivityTs: lastTs,
            };
          });
        } catch(e) { return []; }
      })()
    `) || []
  } catch {
    rendererTabs = []
  }

  if (rendererTabs.length > 0) {
    const mapped = rendererTabs
      .map((t: any) => ({
        id: t.id,
        title: t.customTitle || t.title || 'Tab',
        customTitle: t.customTitle || null,
        status: t.status || 'idle',
        workingDirectory: t.workingDirectory || '',
        permissionMode: (t.permissionMode === 'plan' ? 'plan' : 'auto') as 'auto' | 'plan',
        permissionQueue: (t.permissionQueue || []).map((p: any) => ({
          questionId: p.questionId,
          toolName: p.toolTitle || '',
          toolInput: p.toolInput,
          options: (p.options || []).map((o: any) => ({
            id: o.optionId,
            kind: o.kind,
            label: o.label,
          })),
        })),
        lastMessage: t.lastMessageContent || lastMessagePreview.get(t.id) || null,
        contextTokens: t.contextTokens || null,
        messageCount: t.messageCount || 0,
        queuedPrompts: t.queuedPrompts || [],
        isTerminalOnly: t.isTerminalOnly || undefined,
        isEngine: t.isEngine || undefined,
        engineInstances: t.engineInstances || undefined,
        activeEngineInstanceId: t.activeEngineInstanceId || undefined,
        terminalInstances: t.terminalInstances || undefined,
        activeTerminalInstanceId: t.activeTerminalInstanceId || undefined,
        _activity: t.lastActivityTs || 0,
      }))

    mapped.sort((a, b) => {
      const aRunning = a.status === 'running' || a.status === 'connecting' ? 1 : 0
      const bRunning = b.status === 'running' || b.status === 'connecting' ? 1 : 0
      if (aRunning !== bRunning) return bRunning - aRunning
      return (b._activity as number) - (a._activity as number)
    })

    return mapped.map(({ _activity, ...rest }) => rest)
  }

  const health = sessionPlane.getHealth()
  const healthBySession: Record<string, typeof health.tabs[0]> = {}
  for (const t of health.tabs) {
    if (t.conversationId) {
      healthBySession[t.conversationId] = t
    }
  }

  let persistedTabs: any[] = []
  try {
    if (existsSync(TABS_FILE)) {
      const parsed = JSON.parse(readFileSync(TABS_FILE, 'utf-8'))
      persistedTabs = parsed.tabs || parsed
      if (!Array.isArray(persistedTabs)) persistedTabs = []
    }
  } catch {}

  const results: Array<RemoteTabState & { _activity: number }> = []

  if (persistedTabs.length > 0) {
    for (let i = 0; i < persistedTabs.length; i++) {
      const t = persistedTabs[i]
      const h = t.conversationId ? healthBySession[t.conversationId] : undefined
      results.push({
        id: h?.tabId || `persisted-${i}`,
        title: t.customTitle || t.title || `Tab ${i + 1}`,
        customTitle: t.customTitle || null,
        status: (h?.status || 'idle') as TabStatus,
        workingDirectory: t.workingDirectory || '',
        permissionMode: (t.permissionMode === 'plan' ? 'plan' : 'auto') as 'auto' | 'plan',
        permissionQueue: [],
        lastMessage: null,
        contextTokens: t.contextTokens || null,
        messageCount: 0,
        queuedPrompts: t.queuedPrompts || [],
        _activity: h?.lastActivityAt || 0,
      })
    }
  } else {
    for (const t of health.tabs) {
      results.push({
        id: t.tabId,
        title: t.tabId.substring(0, 8),
        customTitle: null,
        status: t.status,
        workingDirectory: '',
        permissionMode: 'auto' as const,
        permissionQueue: [],
        lastMessage: null,
        contextTokens: null,
        messageCount: 0,
        queuedPrompts: [],
        _activity: t.lastActivityAt || 0,
      })
    }
  }

  results.sort((a, b) => {
    const aRunning = a.status === 'running' || a.status === 'connecting' ? 1 : 0
    const bRunning = b.status === 'running' || b.status === 'connecting' ? 1 : 0
    if (aRunning !== bRunning) return bRunning - aRunning
    return b._activity - a._activity
  })

  return results.map(({ _activity, ...rest }) => rest)
}
