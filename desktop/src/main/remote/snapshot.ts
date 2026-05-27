import { existsSync, readFileSync } from 'fs'
import { state, sessionPlane, lastMessagePreview } from '../state'
import { TABS_FILE } from '../settings-store'
import { log } from '../logger'
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
            // For engine tabs, scan engineMessages for last user/assistant activity
            if (t.isEngine && !lastTs && s.engineMessages && s.engineMessages.get) {
              var ep = s.enginePanes && s.enginePanes.get ? s.enginePanes.get(t.id) : null;
              var instId = ep ? (ep.activeInstanceId || (ep.instances && ep.instances[0] && ep.instances[0].id)) : null;
              var eKey = instId ? (t.id + ':' + instId) : null;
              var eMsgs = eKey ? s.engineMessages.get(eKey) : null;
              if (eMsgs) {
                for (var j = eMsgs.length - 1; j >= 0; j--) {
                  if (eMsgs[j].role === 'assistant' || eMsgs[j].role === 'user') {
                    lastTs = eMsgs[j].timestamp || 0;
                    break;
                  }
                }
              }
            }
            var queue = (t.permissionQueue || []).slice();
            // Promote PER-ENGINE-INSTANCE denials into the parent tab's
            // permissionQueue so the iOS card path (which keys off the
            // tab-level queue) continues to work unchanged at the
            // conversation level. We pick the *active* instance's
            // denial — sibling instances under the same tab are
            // independent sub-conversations and iOS only navigates one
            // engine sub-tab at a time.
            //
            // NB: iOS does NOT consume per-instance waitingState into
            // any parent-tab field; the parent pill glows because the
            // promoted denial is in permissionQueue. The per-instance
            // waitingState (set below on engineInstances[i]) drives the
            // iOS sub-tab pill dot in EngineInstanceBar, not the
            // parent-tab pill. If you ever want to bubble per-instance
            // state into the parent tab fields directly (separate from
            // queue promotion), do it here — not by piping waitingState
            // through to RemoteTabState top-level.
            if (t.isEngine === true && s.enginePermissionDenied && s.enginePermissionDenied.get) {
              var ePane = s.enginePanes && s.enginePanes.get ? s.enginePanes.get(t.id) : null;
              var activeInst = ePane ? (ePane.activeInstanceId || (ePane.instances && ePane.instances[0] && ePane.instances[0].id)) : null;
              if (activeInst) {
                var pdEntry = s.enginePermissionDenied.get(t.id + ':' + activeInst);
                var pdTools = pdEntry && pdEntry.tools;
                if (pdTools && pdTools.length > 0) {
                  for (var pdi = 0; pdi < pdTools.length; pdi++) {
                    queue.push({
                      questionId: 'denied-' + pdTools[pdi].toolUseId,
                      toolName: pdTools[pdi].toolName,
                      toolTitle: pdTools[pdi].toolName,
                      toolInput: pdTools[pdi].toolInput,
                      options: [],
                    });
                  }
                }
              }
            } else if (t.status !== 'failed' && t.status !== 'dead') {
              // CLI tabs: unchanged path. permissionDenied lives on the
              // tab itself.
              var denied = t.permissionDenied && t.permissionDenied.tools;
              if (denied && denied.length > 0) {
                for (var d = 0; d < denied.length; d++) {
                  if (t.status === 'completed' &&
                      denied[d].toolName !== 'ExitPlanMode' &&
                      denied[d].toolName !== 'AskUserQuestion') continue;
                  queue.push({
                    questionId: 'denied-' + denied[d].toolUseId,
                    toolName: denied[d].toolName,
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
            var ePaneForList = ePanes && ePanes.get ? ePanes.get(t.id) : null;
            var engineInstances = undefined;
            var activeEngineInstanceId = undefined;
            if (ePaneForList && ePaneForList.instances && ePaneForList.instances.length > 0) {
              // For each instance, derive its individual waitingState
              // from enginePermissionDenied so iOS can show a per-sub-tab
              // status dot in EngineInstanceBar. 'question' outranks
              // 'plan-ready' (matches desktop's getWaitingState helper).
              engineInstances = ePaneForList.instances.map(function(inst) {
                var ws = null;
                if (s.enginePermissionDenied && s.enginePermissionDenied.get) {
                  var pdEntry = s.enginePermissionDenied.get(t.id + ':' + inst.id);
                  var pdTools = pdEntry && pdEntry.tools;
                  if (pdTools && pdTools.length > 0) {
                    var hasPlanReady = false;
                    for (var k = 0; k < pdTools.length; k++) {
                      if (pdTools[k].toolName === 'AskUserQuestion') { ws = 'question'; break; }
                      if (pdTools[k].toolName === 'ExitPlanMode') hasPlanReady = true;
                    }
                    if (ws === null && hasPlanReady) ws = 'plan-ready';
                  }
                }
                return { id: inst.id, label: inst.label, waitingState: ws };
              });
              activeEngineInstanceId = ePaneForList.activeInstanceId || ePaneForList.instances[0].id;
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
              groupId: t.groupId || null,
              modelOverride: t.modelOverride || null,
              groupPinned: t.groupPinned || false,
              lastMessageContent: lastMsg,
              lastActivityTs: lastTs || 0,
            };
          });
        } catch(e) { return []; }
      })()
    `) || []
  } catch {
    rendererTabs = []
  }

  if (rendererTabs.length > 0) {
    // Log any tabs carrying a non-empty permissionQueue so we can confirm
    // the blue-dot data survives iOS relaunch.
    for (const t of rendererTabs) {
      if (t.permissionQueue?.length > 0) {
        const qIds = (t.permissionQueue || []).map((p: any) => `${p.toolTitle || p.toolName}(${p.questionId?.slice(-8)})`).join(', ')
        log('snapshot', `tab=${t.id?.slice(0, 8)} status=${t.status} permQueue=[${qIds}]`)
      }
    }
    const mapped = rendererTabs
      .map((t: any) => ({
        id: t.id,
        title: t.customTitle || t.title || 'Tab',
        customTitle: t.customTitle || null,
        status: t.status || 'idle',
        workingDirectory: t.workingDirectory || '',
        permissionMode: (t.permissionMode === 'plan' ? 'plan' : 'auto') as 'auto' | 'plan',
        permissionQueue: (t.permissionQueue || []).map((p: any) => {
          const entry = {
            questionId: p.questionId,
            toolName: p.toolTitle || '',
            toolInput: p.toolInput,
            options: (p.options || []).map((o: any) => ({
              id: o.optionId,
              kind: o.kind,
              label: o.label,
            })),
          }
          // Enrich ExitPlanMode entries with planContent by reading the plan file
          if (entry.toolName === 'ExitPlanMode' && entry.toolInput?.planFilePath && !entry.toolInput?.planContent) {
            try {
              entry.toolInput = { ...entry.toolInput, planContent: readFileSync(entry.toolInput.planFilePath as string, 'utf-8') }
            } catch {}
          }
          return entry
        }),
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
        groupId: t.groupId || null,
        modelOverride: t.modelOverride || null,
        groupPinned: t.groupPinned || false,
        lastActivityAt: t.lastActivityTs || undefined,
      }))

    mapped.sort((a, b) => {
      const aRunning = a.status === 'running' || a.status === 'connecting' ? 1 : 0
      const bRunning = b.status === 'running' || b.status === 'connecting' ? 1 : 0
      if (aRunning !== bRunning) return bRunning - aRunning
      return (b.lastActivityAt || 0) - (a.lastActivityAt || 0)
    })

    return mapped
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

  const results: RemoteTabState[] = []

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
        modelOverride: null,
        lastActivityAt: h?.lastActivityAt || undefined,
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
        lastActivityAt: t.lastActivityAt || undefined,
      })
    }
  }

  results.sort((a, b) => {
    const aRunning = a.status === 'running' || a.status === 'connecting' ? 1 : 0
    const bRunning = b.status === 'running' || b.status === 'connecting' ? 1 : 0
    if (aRunning !== bRunning) return bRunning - aRunning
    return (b.lastActivityAt || 0) - (a.lastActivityAt || 0)
  })

  return results
}
