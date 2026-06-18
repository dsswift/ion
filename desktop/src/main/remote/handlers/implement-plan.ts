import { existsSync, readFileSync } from 'fs'
import { log as _log } from '../../logger'
import { state, sessionPlane } from '../../state'
import { processIncomingPrompt } from '../../prompt-pipeline'
import { handleSetPermissionMode } from './tabs'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

/**
 * Handles implement_plan from iOS.
 *
 * iOS sends this command instead of building a prompt string. The desktop
 * runs the same implement pipeline that the renderer's onImplement
 * (usePermissionDeniedHandlers.ts) runs — no plan body crosses the wire.
 *
 * Pipeline steps (mirrors onImplement exactly):
 *   1. Resolve planFilePath from the renderer store (instance.planFilePath
 *      or permissionDenied.tools[ExitPlanMode].toolInput.planFilePath).
 *   2. Read plan content from disk.
 *   3. setPermissionMode → auto (flips the engine's plan mode off).
 *   4. Renderer-side mutations: model switch (planModelSplitEnabled),
 *      group auto-move, insert implement divider, clear plan state.
 *      These run via executeJavaScript so the desktop UI stays consistent.
 *   5. If clearContext: resetTabSession + archive conversationId.
 *   6. Send the implement prompt through processIncomingPrompt with
 *      implementationPhase=true and the plan file as an attachment.
 *
 * NON-NEGOTIABLE: processIncomingPrompt IS the single implement seam. No
 * second copy of the pipeline. The renderer's onImplement also reaches
 * the engine via the renderer's sendMessage → window.ion.prompt →
 * sessionPlane.submitPrompt; this handler reaches the engine through the
 * same processIncomingPrompt path that handlePrompt uses (main-process
 * pipeline, no renderer round-trip for the send step).
 */
export async function handleImplementPlan(
  cmd: Extract<RemoteCommand, { type: 'desktop_implement_plan' }>,
): Promise<void> {
  const { tabId, questionId, instanceId, clearContext = false } = cmd
  log(`handleImplementPlan: tabId=${tabId.slice(0, 8)} questionId=${questionId.slice(0, 12)} clearContext=${clearContext}`)

  // Step 1: Resolve planFilePath — same two-source lookup as onImplement lines 122-131.
  let planFilePath: string | null = null
  try {
    const escapedTab = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    planFilePath = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return null;
          var s = store.getState();
          var panes = s.conversationPanes;
          if (!panes) return null;
          var pane = panes instanceof Map ? panes.get('${escapedTab}') : (panes['${escapedTab}'] || null);
          if (!pane) return null;
          var inst = pane.instances.find(function(i) { return i.id === pane.activeInstanceId; })
            || pane.instances[0];
          if (!inst) return null;
          if (inst.planFilePath) return inst.planFilePath;
          var denied = inst.permissionDenied && inst.permissionDenied.tools;
          if (denied) {
            for (var d = 0; d < denied.length; d++) {
              if (denied[d].toolName === 'ExitPlanMode'
                  && denied[d].toolInput
                  && denied[d].toolInput.planFilePath) {
                return denied[d].toolInput.planFilePath;
              }
            }
          }
          return null;
        } catch(e) { return null; }
      })()
    `) || null
  } catch (err) {
    log(`handleImplementPlan: planFilePath lookup failed: ${(err as Error).message}`)
  }
  log(`handleImplementPlan: planFilePath=${planFilePath ?? '<none>'}`)

  // Step 2: Read plan content from disk (mirrors onImplement lines 134-142).
  let planContent: string | null = null
  if (planFilePath && existsSync(planFilePath)) {
    try {
      planContent = readFileSync(planFilePath, 'utf-8')
    } catch (err) {
      log(`handleImplementPlan: plan read failed: ${(err as Error).message}`)
    }
  }

  // Step 3: Set permission mode → auto (same as onImplement line 102).
  await handleSetPermissionMode({ type: 'desktop_set_permission_mode', tabId, mode: 'auto' })

  // Step 4: Renderer-side model switch + group auto-move (onImplement lines 105-118).
  // These are prefs-driven so we read them from the renderer stores.
  try {
    const escapedTab = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          var prefs = window.__Ion_PREFS_STORE__;
          if (!store || !prefs) return;
          var s = store.getState();
          var p = prefs.getState();
          if (p.planModelSplitEnabled && p.implementModeModel) {
            s.setTabModel('${escapedTab}', p.implementModeModel);
          }
          var tab = s.tabs.find(function(t) { return t.id === '${escapedTab}'; });
          if (tab
              && p.autoGroupMovement
              && p.inProgressGroupId
              && p.tabGroupMode === 'manual'
              && tab.groupId !== p.inProgressGroupId
              && !tab.groupPinned) {
            s.moveTabToGroup('${escapedTab}', p.inProgressGroupId);
          }
        } catch(e) {}
      })()
    `)
  } catch (err) {
    log(`handleImplementPlan: renderer model/group step failed: ${(err as Error).message}`)
  }

  // Step 5: clearContext branch — reset engine session before implementing.
  // Matches onImplement lines 150-194. The main-process resetTabSession call
  // must happen before the renderer state mutation so the engine session is
  // already gone when the store clears conversationId.
  if (clearContext) {
    sessionPlane.resetTabSession(tabId)
  }

  // Step 6: Renderer store mutations — insert divider, clear plan state.
  // Mirrors onImplement lines 159-233. Both clearContext branches handled here.
  try {
    const escapedTab = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const clearCtxJs = clearContext ? 'true' : 'false'
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return;
          var s = store.getState();
          var clearCtx = ${clearCtxJs};
          var panes = s.conversationPanes;
          if (!panes) return;
          var pane = panes instanceof Map ? panes.get('${escapedTab}') : (panes['${escapedTab}'] || null);
          if (!pane) return;
          var inst = pane.instances.find(function(i) { return i.id === pane.activeInstanceId; })
            || pane.instances[0];
          if (!inst) return;
          var divider = '\\u2500\\u2500 Implementing plan at '
            + new Date().toLocaleTimeString() + ' \\u2500\\u2500';
          var newMsg = { id: 'impl-remote-' + Date.now(), role: 'system',
            content: divider, timestamp: Date.now() };
          var updatedInst = Object.assign({}, inst, {
            messages: inst.messages.concat([newMsg]),
            planFilePath: null,
            permissionQueue: [],
            permissionDenied: null,
          });
          var newInstances = pane.instances.map(function(i) {
            return i.id === updatedInst.id ? updatedInst : i;
          });
          var newPane = Object.assign({}, pane, { instances: newInstances });
          var newPanes;
          if (panes instanceof Map) {
            newPanes = new Map(panes);
            newPanes.set('${escapedTab}', newPane);
          } else {
            newPanes = Object.assign({}, panes);
            newPanes['${escapedTab}'] = newPane;
          }
          if (clearCtx) {
            var tab = s.tabs.find(function(t) { return t.id === '${escapedTab}'; });
            var convId = tab && tab.conversationId;
            var hist = tab ? (tab.historicalSessionIds || []) : [];
            var newHist = (convId && !hist.includes(convId)) ? hist.concat([convId]) : hist;
            store.setState({
              conversationPanes: newPanes,
              tabs: s.tabs.map(function(t) {
                return t.id !== '${escapedTab}' ? t : Object.assign({}, t, {
                  historicalSessionIds: newHist,
                  conversationId: null,
                  lastResult: null,
                  currentActivity: '',
                  queuedPrompts: [],
                });
              }),
            });
          } else {
            store.setState({
              conversationPanes: newPanes,
              tabs: s.tabs.map(function(t) {
                return t.id !== '${escapedTab}' ? t : Object.assign({}, t, {
                  lastResult: null,
                  currentActivity: '',
                  queuedPrompts: [],
                });
              }),
            });
          }
        } catch(e) {}
      })()
    `)
  } catch (err) {
    log(`handleImplementPlan: renderer state mutation failed: ${(err as Error).message}`)
  }

  // Step 7: Determine tab type for processIncomingPrompt routing.
  let isEngineTab = false
  let resolvedInstanceId: string | null = instanceId || null
  try {
    const escapedTab = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const tabInfo = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return null;
        var s = store.getState();
        var tab = s.tabs.find(function(t) { return t.id === '${escapedTab}'; });
        if (!tab) return null;
        var pane = s.conversationPanes instanceof Map
          ? s.conversationPanes.get('${escapedTab}')
          : (s.conversationPanes ? s.conversationPanes['${escapedTab}'] : null);
        return {
          hasEngineExtension: !!tab.hasEngineExtension,
          activeInstanceId: pane ? pane.activeInstanceId : null,
        };
      })()
    `)
    if (tabInfo) {
      isEngineTab = !!tabInfo.hasEngineExtension
      if (!resolvedInstanceId) resolvedInstanceId = tabInfo.activeInstanceId || null
    }
  } catch {}

  // Step 8: Build prompt + attachment — same as onImplement lines 253-264.
  // The plan body is resolved desktop-side; no plan text was in the command.
  const implementPrompt = planContent
    ? `Implement the following plan:\n\n${planContent}`
    : 'Implement the plan.'

  const reqId = `remote-impl-${Date.now()}`

  // Echo the user message to iOS so the conversation history shows the intent.
  state.remoteTransport?.send({
    type: 'desktop_message_added',
    tabId,
    message: { id: reqId, role: 'user', content: implementPrompt, timestamp: Date.now(), source: 'remote' },
  })

  // Send through the unified pipeline — same path as handlePrompt → processIncomingPrompt.
  // implementationPhase=true suppresses EnterPlanMode injection on the engine side.
  // planFilePath is the separate IncomingPrompt field (not in attachments) that the
  // engine bridge uses to restore plan-file state after a desktop restart.
  void processIncomingPrompt({
    tabId,
    text: implementPrompt,
    reqId,
    source: 'remote',
    isEngineTab,
    instanceId: resolvedInstanceId || undefined,
    implementationPhase: true,
    planFilePath: planFilePath || undefined,
  }).catch((err: unknown) => {
    log(`handleImplementPlan: pipeline error: ${(err as Error).message}`)
  })
}
