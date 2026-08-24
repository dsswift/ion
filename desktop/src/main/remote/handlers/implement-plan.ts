import { existsSync, readFileSync } from 'fs'
import { log as _log, debug as _debug } from '../../logger'
import { state, sessionPlane } from '../../state'
import { processIncomingPrompt } from '../../prompt-pipeline'
import { echoUserTurn } from '../../user-turn-echo'
import { handleSetPermissionMode } from './tabs'
import { planSlugFromPath } from '../../../shared/clear-divider'
import type { RemoteCommand } from '../protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('main', msg, fields)
}

/**
 * Handles implement_plan from iOS.
 *
 * iOS sends this command instead of building a prompt string. The desktop
 * runs the same implement pipeline that the renderer's implementPlan
 * (implement-slice.ts) runs — no plan body crosses the wire.
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
  log('handle_implement_plan', { tab_id: tabId.slice(0, 8), question_id: questionId.slice(0, 12), clear_context: clearContext })

  // Step 1: Resolve planFilePath — same two-source lookup as implementPlan.
  let planFilePath: string | null = null
  try {
    const escapedTab = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const lookup = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return { path: null, error: 'store unavailable' };
          var s = store.getState();
          var panes = s.conversationPanes;
          if (!panes) return { path: null, error: 'conversation panes unavailable' };
          var pane = panes instanceof Map ? panes.get('${escapedTab}') : (panes['${escapedTab}'] || null);
          if (!pane) return { path: null, error: 'conversation pane unavailable' };
          var inst = pane.instances.find(function(i) { return i.id === pane.activeInstanceId; })
            || pane.instances[0];
          if (!inst) return { path: null, error: 'conversation instance unavailable' };
          if (inst.planFilePath) return { path: inst.planFilePath };
          var denied = inst.permissionDenied && inst.permissionDenied.tools;
          if (denied) {
            for (var d = 0; d < denied.length; d++) {
              if (denied[d].toolName === 'ExitPlanMode'
                  && denied[d].toolInput
                  && denied[d].toolInput.planFilePath) {
                return { path: denied[d].toolInput.planFilePath };
              }
            }
          }
          return { path: null };
        } catch(e) { return { path: null, error: String(e) }; }
      })()
    `) as { path?: string | null; error?: string } | undefined
    planFilePath = lookup?.path || null
    if (lookup?.error) {
      log('handle_implement_plan: plan file lookup rejected', { error: lookup.error })
    }
  } catch (err) {
    log('handle_implement_plan: plan file lookup failed', { error: (err as Error).message })
  }
  log('handle_implement_plan: plan file path', { path: planFilePath ?? '' })

  // Step 2: Read plan content from disk (mirrors implementPlan).
  let planContent: string | null = null
  if (planFilePath && existsSync(planFilePath)) {
    try {
      planContent = readFileSync(planFilePath, 'utf-8')
    } catch (err) {
      log('handle_implement_plan: plan read failed', { error: (err as Error).message })
    }
  }

  // Step 3: Set permission mode → auto (same as implementPlan).
  await handleSetPermissionMode({ type: 'desktop_set_permission_mode', tabId, mode: 'auto' })

  // Step 4: Renderer-side model switch + group auto-move (mirrors implementPlan).
  // These are prefs-driven so we read them from the renderer stores.
  try {
    const escapedTab = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const modelGroupResult = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          var prefs = window.__Ion_PREFS_STORE__;
          if (!store || !prefs) return { ok: false, reason: 'store unavailable' };
          var s = store.getState();
          var p = prefs.getState();
          if (p.planModelSplitEnabled && p.implementModeModel) {
            s.setTabAutomaticModel('${escapedTab}', p.implementModeModel);
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
          return { ok: true };
        } catch(e) { return { ok: false, reason: String(e) }; }
      })()
    `) as { ok?: boolean; reason?: string } | undefined
    if (modelGroupResult && !modelGroupResult.ok) {
      log('handle_implement_plan: renderer model/group rejected', { reason: modelGroupResult.reason ?? 'unknown' })
    }
  } catch (err) {
    log('handle_implement_plan: renderer model/group step failed', { error: (err as Error).message })
  }

  // Approval resolves the plan question, so release the engine's retention of
  // the ExitPlanMode denial. Parity with the renderer's implementPlan: without
  // this, a heartbeat during the reset/submit window re-offers the card iOS
  // just approved. Runs before the reset so the notify reaches the session
  // that still holds the retention.
  sessionPlane.resolvePermissionDenials(tabId)

  // Step 5: clearContext branch — reset engine session before implementing.
  // Matches the implementPlan clearContext branch. The main-process resetTabSession call
  // must happen before the renderer state mutation so the engine session is
  // already gone when the store clears conversationId.
  if (clearContext) {
    sessionPlane.resetTabSession(tabId)
  }

  // Step 6: Renderer store mutations — insert divider, clear plan state.
  // Mirrors implementPlan. Both clearContext branches handled here.
  try {
    const escapedTab = tabId.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const clearCtxJs = clearContext ? 'true' : 'false'
    // Carry the resolved plan path + slug onto the divider so the renderer
    // (and the snapshot projection that mirrors it to iOS) renders the slug as
    // a clickable link to the plan preview — same treatment as the desktop
    // onImplement path and the plan-created / plan-updated dividers. Escape
    // both values for safe string interpolation into the executeJavaScript.
    const planSlug = planSlugFromPath(planFilePath)
    const slugSuffix = planSlug ? ` \\u00b7 ${planSlug.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}` : ''
    const planPathJs = planFilePath
      ? `'${planFilePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
      : 'null'
    const mutationResult = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        try {
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return { ok: false, reason: 'store unavailable' };
          var s = store.getState();
          var clearCtx = ${clearCtxJs};
          var panes = s.conversationPanes;
          if (!panes) return { ok: false, reason: 'conversation panes unavailable' };
          var pane = panes instanceof Map ? panes.get('${escapedTab}') : (panes['${escapedTab}'] || null);
          if (!pane) return { ok: false, reason: 'conversation pane unavailable' };
          var inst = pane.instances.find(function(i) { return i.id === pane.activeInstanceId; })
            || pane.instances[0];
          if (!inst) return { ok: false, reason: 'conversation instance unavailable' };
          var planPath = ${planPathJs};
          var divider = '\\u2500\\u2500 Implementing plan at '
            + new Date().toLocaleTimeString() + '${slugSuffix}' + ' \\u2500\\u2500';
          var newMsg = { id: 'impl-remote-' + Date.now(), role: 'system',
            content: divider, timestamp: Date.now() };
          if (planPath) newMsg.planFilePath = planPath;
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
          return { ok: true };
        } catch(e) { return { ok: false, reason: String(e) }; }
      })()
    `) as { ok?: boolean; reason?: string } | undefined
    if (mutationResult && !mutationResult.ok) {
      log('handle_implement_plan: renderer state mutation rejected', { reason: mutationResult.reason ?? 'unknown' })
    }
  } catch (err) {
    log('handle_implement_plan: renderer state mutation failed', { error: (err as Error).message })
  }

  // Step 7: Determine tab type for processIncomingPrompt routing.
  let hasExtensions = false
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
          hasExtensions: !!tab.engineProfileId,
          activeInstanceId: pane ? pane.activeInstanceId : null,
        };
      })()
    `)
    if (tabInfo) {
      hasExtensions = !!tabInfo.hasExtensions
      if (!resolvedInstanceId) resolvedInstanceId = tabInfo.activeInstanceId || null
    }
  } catch (err) {
    // Probe failure degrades to defaults (no extensions, caller-supplied
    // instanceId); log so the degraded routing is diagnosable.
    debug('implement_plan: tab-info renderer probe failed', { tab_id: tabId, error: String(err) })
  }

  // Step 8: Build prompt + attachment — same as implementPlan.
  // The plan body is resolved desktop-side; no plan text was in the command.
  const implementPrompt = planContent
    ? `Implement the following plan:\n\n${planContent}`
    : 'Implement the plan.'

  const reqId = `remote-impl-${Date.now()}`

  // Echo the user message so the conversation history shows the intent.
  // Through the funnel: one classification rule for every user-turn echo.
  echoUserTurn({
    tabId,
    id: reqId,
    content: implementPrompt,
    source: 'remote',
    implementationPhase: true,
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
    hasExtensions,
    instanceId: resolvedInstanceId || undefined,
    implementationPhase: true,
    planFilePath: planFilePath || undefined,
  }).catch((err: unknown) => {
    log('handle_implement_plan: pipeline error', { error: (err as Error).message })
  })
}
