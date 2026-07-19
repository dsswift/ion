/**
 * snapshot-renderer-poll — the LEGACY renderer-poll path, kept solely as the
 * cold-start / stall fallback for the renderer-push snapshot architecture.
 *
 * ── Why this file still exists ──────────────────────────────────────────────
 * The primary snapshot source is the renderer-push cache: the OWNER renderer
 * projects RemoteTabStatesPayload from its session store on change (see
 * renderer/stores/remote-projection.ts + remote-projection-push.ts) and pushes
 * it over IPC.REMOTE_TAB_STATES_PUSH; getRemoteTabStates() (snapshot.ts)
 * serves that cache. This poll runs ONLY when the cache is empty or stale
 * (> RENDERER_CACHE_MAX_AGE_MS): renderer not yet hydrated, renderer hung, or
 * the push subscription not yet initialized. This is a cited keep, not dead
 * code — without it a paired iOS device would see zero live tabs for the
 * whole window between desktop launch and the renderer's first push.
 *
 * ── Contract with the extracted projection ──────────────────────────────────
 * The IIFE below MUST produce field-for-field the same ProjectedRendererTab
 * shape as projectRemoteTabStates (renderer/stores/remote-projection.ts) —
 * that module is the canonical, unit-tested implementation; this string is
 * its evaluated-in-renderer-scope mirror for the fallback window only. The
 * parity suites assert the canonical module; source-pin tests in
 * __tests__/snapshot-iife-scope.test.ts guard the string's renderer-scope
 * constraints (no main-process symbols, inlined helpers).
 *
 * ── Renderer-scope constraints (#256 Defect 2) ──────────────────────────────
 * The IIFE is evaluated in the RENDERER global scope via executeJavaScript
 * and CANNOT reference main-process imports — any such reference throws a
 * ReferenceError on every poll, silently degrading the snapshot to the
 * cold-start path. Helpers (tabHasExtensions, the running-children fold) are
 * therefore inlined; keep them in sync with shared/tab-predicates.ts and
 * TabStripShared.ts effectiveRunningChildrenCount.
 *
 * Logging: the IIFE routes through window.ion.logWrite (the preload logging
 * bridge, same sink as rendererLogger) — never console.* (ADR-019).
 */

import { state } from '../state'
import { debug } from '../logger'
import type { RemoteTabStatesPayload } from '../../shared/remote-projection-types'

/**
 * Run the legacy executeJavaScript projection once and return the payload.
 * Returns an empty payload when the window is absent, the store is not yet
 * mounted, or the IIFE throws (the IIFE logs its own failure via the
 * logWrite bridge).
 */
export async function pollRendererTabStates(): Promise<RemoteTabStatesPayload> {
  let result: RemoteTabStatesPayload = { tabs: [], resourceManifest: {} }
  try {
    result = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        try {
          // Inlined copy of tabHasExtensions (../../shared/tab-predicates).
          // Renderer-scope constraint — see the module doc above. The
          // predicate is pure (engineProfileId non-null, non-empty), so it is
          // safe to inline here. Keep this in sync with tab-predicates.ts.
          function tabHasExtensions(t) {
            return t.engineProfileId != null && t.engineProfileId !== '';
          }
          // Structured logging bridge (preload logWrite → desktop.jsonl).
          // console.* is forbidden in renderer-evaluated code (ADR-019).
          function fallbackLog(level, msg, fields) {
            if (window.ion && typeof window.ion.logWrite === 'function') {
              window.ion.logWrite(level, 'snapshot-fallback', msg, fields || {});
            }
          }
          var store = window.__Ion_SESSION_STORE__;
          if (!store) return { tabs: [], resourceManifest: {} };
          var s = store.getState();
          var panes = s.terminalPanes;
          var resources = s.resources || {};
          var readIds = s.readResourceIds instanceof Set ? Array.from(s.readResourceIds) : [];
          var resourceManifest = {};
          Object.keys(resources).forEach(function(kind) {
            resourceManifest[kind] = (resources[kind] || []).map(function(r) {
              return { id: r.id, kind: r.kind, title: r.title || '', createdAt: r.createdAt, read: readIds.indexOf(r.id) >= 0, conversationId: r.conversationId || undefined };
            });
          });
          var tabs = s.tabs.map(function(t) {
            // Resolve the ACTIVE conversation instance once. Every tab (plain
            // or extension-hosted) stores messages / permissionDenied /
            // permissionQueue / permissionMode on a ConversationInstance in
            // conversationPanes (a plain conversation has a single 'main'
            // instance). This is the unified read source; no tab-level fork.
            var cPane = s.conversationPanes && s.conversationPanes.get ? s.conversationPanes.get(t.id) : null;
            var activeInstId = cPane ? (cPane.activeInstanceId || (cPane.instances && cPane.instances[0] && cPane.instances[0].id)) : null;
            var activeInst = (activeInstId && cPane) ? cPane.instances.find(function(i) { return i.id === activeInstId; }) : null;

            var msgs = activeInst ? (activeInst.messages || []) : [];
            var lastMsg = null;
            var lastTs = 0;
            // lastMsg (the tab-list preview text) comes from the last user/
            // assistant row — a tool row has no useful preview string.
            for (var i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'assistant' || msgs[i].role === 'user') {
                lastMsg = (msgs[i].content || '').substring(0, 100);
                break;
              }
            }
            // lastActivityAt (the tab SORT key) must reflect the newest activity
            // of ANY role, including a trailing tool run. Take the max timestamp
            // across all rows so an actively-tool-working tab sorts as recently
            // active. Cheap: bounded by page size.
            for (var ti = msgs.length - 1; ti >= 0; ti--) {
              var rowTs = msgs[ti].timestamp || 0;
              if (rowTs > lastTs) lastTs = rowTs;
            }
            // Conversation tail fingerprint — the staleness signal for the iOS
            // main-conversation heal. store.getState().computeConvFingerprint
            // wraps the canonical conversationTailFingerprint() from
            // shared/conversation-fingerprint.ts. The Swift copy must remain
            // byte-identical; any algorithm change starts there.
            var convFingerprint = (typeof s.computeConvFingerprint === 'function')
              ? (s.computeConvFingerprint(t.id) || '')
              : '';
            // Live interactive permission requests live on the active instance.
            var queue = (activeInst && activeInst.permissionQueue ? activeInst.permissionQueue : []).slice();
            // Live extension elicitations (ctx.elicit) also live on the active
            // instance; project them so iOS can render an approval card.
            var elicitQueue = (activeInst && activeInst.elicitationQueue ? activeInst.elicitationQueue : []).slice();
            // Promote the active instance's non-interactive denials into the
            // queue — same semantics as projectRemoteTabStates; see
            // remote-projection.ts for the full rationale (stale-residue
            // suppression on running/connecting, tab-type-agnostic
            // idle/completed promotion, instanceId scoping for extensions).
            if (activeInst && t.status !== 'failed' && t.status !== 'dead' && t.status !== 'running' && t.status !== 'connecting') {
              var pdEntry = activeInst.permissionDenied;
              var pdTools = pdEntry && pdEntry.tools;
              if (pdTools && pdTools.length > 0) {
                for (var pdi = 0; pdi < pdTools.length; pdi++) {
                  var pdEntryOut = {
                    questionId: 'denied-' + pdTools[pdi].toolUseId,
                    toolName: pdTools[pdi].toolName,
                    toolTitle: pdTools[pdi].toolName,
                    toolInput: pdTools[pdi].toolInput,
                    options: []
                  };
                  if (tabHasExtensions(t)) pdEntryOut.instanceId = activeInstId;
                  queue.push(pdEntryOut);
                }
              }
            }
            // Log when a running/connecting tab's denial promotion is
            // suppressed so the skip is observable in desktop.jsonl.
            if (activeInst && (t.status === 'running' || t.status === 'connecting')) {
              var pdSkipEntry = activeInst.permissionDenied;
              var pdSkipTools = pdSkipEntry && pdSkipEntry.tools;
              if (pdSkipTools && pdSkipTools.length > 0) {
                fallbackLog('DEBUG', 'suppressed stale denial promotion', { tab_id: t.id.slice(0, 8), status: t.status, tools: pdSkipTools.map(function(p) { return p.toolName + '(' + p.toolUseId.slice(-8) + ')'; }).join(',') });
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
            // List the conversation pane's instances so iOS can render the
            // per-sub-tab EngineInstanceBar. Same derivations as
            // remote-projection.ts (waitingState, isRunning, running-children
            // fold, model fallback) — see that module for the full rationale.
            var ePaneForList = cPane;
            var conversationInstances = undefined;
            var activeConversationInstanceId = undefined;
            if (ePaneForList && ePaneForList.instances && ePaneForList.instances.length > 0) {
              conversationInstances = ePaneForList.instances.map(function(inst) {
                var ws = null;
                var pdEntry = inst.permissionDenied;
                var pdTools = pdEntry && pdEntry.tools;
                if (pdTools && pdTools.length > 0) {
                    var hasPlanReady = false;
                    for (var k = 0; k < pdTools.length; k++) {
                      if (pdTools[k].toolName === 'AskUserQuestion') { ws = 'question'; break; }
                      if (pdTools[k].toolName === 'ExitPlanMode') hasPlanReady = true;
                    }
                    if (ws === null && hasPlanReady) ws = 'plan-ready';
                }
                var instRunning = false;
                var sf = inst.statusFields;
                if (sf) {
                  var st = sf.state;
                  instRunning = st === 'running' || st === 'connecting' || st === 'starting';
                }
                // Inlined running-children fold — keep in sync with
                // effectiveRunningChildrenCount in TabStripShared.ts (the
                // canonical helper, which remote-projection.ts imports
                // directly; this IIFE cannot import — renderer scope).
                // Max (not sum) of agentStates and backgroundAgents: two
                // vantage points on the same underlying agents.
                var instRunningAgents = 0;
                var ags = inst.agentStates;
                var fromAgentStates = 0;
                if (ags && Array.isArray(ags)) {
                  for (var ai = 0; ai < ags.length; ai++) {
                    if (ags[ai] && ags[ai].status === 'running') fromAgentStates++;
                  }
                }
                var fromBackgroundAgents = (inst.statusFields && inst.statusFields.backgroundAgents) || 0;
                instRunningAgents = Math.max(fromAgentStates, fromBackgroundAgents);
                // Per-instance model-fallback indicator (⚠ on the iOS
                // EngineInstanceBar). Only requested + fallback model strings
                // are forwarded — see remote-projection.ts.
                var mfOut = undefined;
                if (s.engineModelFallbacks && s.engineModelFallbacks.get) {
                  const mf = s.engineModelFallbacks.get(t.id + ':' + inst.id);
                  if (mf) {
                    mfOut = { requestedModel: mf.requestedModel, fallbackModel: mf.fallbackModel };
                  }
                }
                return { id: inst.id, label: inst.label, waitingState: ws, isRunning: instRunning || undefined, runningAgentCount: instRunningAgents > 0 ? instRunningAgents : undefined, modelFallback: mfOut, conversationIds: inst.conversationIds && inst.conversationIds.length > 0 ? inst.conversationIds : undefined, thinkingEffort: (inst.thinkingEffort && inst.thinkingEffort !== 'off') ? inst.thinkingEffort : undefined, dispatchTelemetry: inst.dispatchTelemetry && inst.dispatchTelemetry.length > 0 ? inst.dispatchTelemetry : undefined };
              });
              activeConversationInstanceId = ePaneForList.activeInstanceId || ePaneForList.instances[0].id;
            }
            // Aggregate "any instance has running background children" —
            // drives the iOS parent tab pill's yellow "awaiting children" dot.
            var anyInstanceHasRunningChildren = false;
            if (conversationInstances) {
              for (var ei = 0; ei < conversationInstances.length; ei++) {
                if ((conversationInstances[ei].runningAgentCount || 0) > 0) anyInstanceHasRunningChildren = true;
                if (anyInstanceHasRunningChildren) break;
              }
            }
            return {
              id: t.id,
              title: t.title,
              customTitle: t.customTitle,
              // WI-001 makes t.status authoritative for every conversation;
              // status projects uniformly for all tabs.
              status: t.status,
              workingDirectory: t.workingDirectory,
              // All tab types store permissionMode on the active conversation
              // instance (WI-002); activeInst is the single read source.
              permissionMode: (activeInst && activeInst.permissionMode) || 'auto',
              permissionQueue: queue,
              elicitationQueue: elicitQueue,
              // Omitted when 'off'/absent so the iOS control defaults to off.
              thinkingEffort: (function() {
                var eff = activeInst && activeInst.thinkingEffort;
                return (eff && eff !== 'off') ? eff : undefined;
              })(),
              contextTokens: t.contextTokens,
              contextWindow: t.contextWindow ?? null,
              messageCount: (msgs.length > 0 ? msgs.length : (activeInst && activeInst.messageCount) || 0),
              queuedPrompts: t.queuedPrompts || [],
              isTerminalOnly: t.isTerminalOnly || undefined,
              hasEngineExtension: tabHasExtensions(t) || undefined,
              // iOS resolves the harness badge display name by matching
              // engineProfileId against the desktop_engine_profiles list.
              engineProfileId: t.engineProfileId || null,
              conversationInstances: conversationInstances,
              activeConversationInstanceId: activeConversationInstanceId,
              terminalInstances: terminalInstances,
              activeTerminalInstanceId: activeTerminalInstanceId,
              groupId: t.groupId || null,
              modelOverride: (activeInst && activeInst.modelOverride) || null,
              groupPinned: t.groupPinned || false,
              hasRunningChildren: anyInstanceHasRunningChildren || undefined,
              conversationId: t.conversationId || null,
              lastMessageContent: lastMsg,
              lastActivityTs: lastTs || 0,
              convFingerprint: convFingerprint,
              pillColor: t.pillColor || null,
              pillIcon: t.pillIcon || null,
              // Cold-start parity: cost + token fields from the active
              // instance's statusFields and lastResult — see
              // remote-projection.ts for the precedence rationale.
              runCostUsd: (function() {
                var liveCost = activeInst && activeInst.statusFields && typeof activeInst.statusFields.runCostUsd === 'number' ? activeInst.statusFields.runCostUsd : undefined;
                if (liveCost !== undefined) return liveCost;
                return t.lastResult && typeof t.lastResult.totalCostUsd === 'number' ? t.lastResult.totalCostUsd : undefined;
              })(),
              conversationCostUsd: (activeInst && activeInst.statusFields && typeof activeInst.statusFields.conversationCostUsd === 'number') ? activeInst.statusFields.conversationCostUsd : undefined,
              conversationTurns: (function() {
                var live = activeInst && activeInst.statusFields && typeof activeInst.statusFields.conversationTurns === 'number' ? activeInst.statusFields.conversationTurns : undefined;
                if (live !== undefined) return live;
                return t.lastResult && typeof t.lastResult.conversationTurns === 'number' ? t.lastResult.conversationTurns : undefined;
              })(),
              inputTokens: (t.lastResult && t.lastResult.usage && typeof t.lastResult.usage.input_tokens === 'number') ? t.lastResult.usage.input_tokens : undefined,
              outputTokens: (t.lastResult && t.lastResult.usage && typeof t.lastResult.usage.output_tokens === 'number') ? t.lastResult.usage.output_tokens : undefined,
              cacheReadTokens: (t.lastResult && t.lastResult.usage && typeof t.lastResult.usage.cache_read_input_tokens === 'number') ? t.lastResult.usage.cache_read_input_tokens : undefined,
              cacheCreationTokens: (t.lastResult && t.lastResult.usage && typeof t.lastResult.usage.cache_creation_input_tokens === 'number') ? t.lastResult.usage.cache_creation_input_tokens : undefined,
            };
          });
          return { tabs: tabs, resourceManifest: resourceManifest };
        } catch(e) {
          // Never fail silently. A throw here degrades the fallback snapshot
          // to the cold-start path (missing groupId / pillColor /
          // conversationInstances), so it must be observable. The original
          // ReferenceError (calling a main-process import inside this IIFE)
          // went undetected for exactly this reason. Routed through the
          // logWrite bridge (ADR-019 — no console.* in renderer-evaluated code).
          if (window.ion && typeof window.ion.logWrite === 'function') {
            window.ion.logWrite('ERROR', 'snapshot-fallback', 'fallback IIFE failed, degrading to cold-start', { error: (e && e.message ? e.message : String(e)) });
          }
          return { tabs: [], resourceManifest: {} };
        }
      })()
    `) || { tabs: [], resourceManifest: {} }
  } catch (err) {
    // executeJavaScript itself rejected (window mid-teardown, script error
    // outside the IIFE's try). Observable at debug — the caller handles the
    // empty payload via the cold-start path.
    debug('snapshot-fallback', 'executeJavaScript rejected', { error: (err as Error).message })
    result = { tabs: [], resourceManifest: {} }
  }
  return result
}
