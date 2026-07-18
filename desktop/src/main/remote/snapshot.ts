import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { state, sessionPlane, lastMessagePreview } from '../state'
import { TABS_FILE } from '../settings-store'
import { isResourceRead } from '../event-wiring-resources'
import { log, debug } from '../logger'
import type { RemoteTabState } from './protocol'
import type { TabStatus } from '../../shared/types'
import { projectRendererTab } from './snapshot-project'

export type ResourceManifest = Record<string, Array<{ id: string; kind: string; title?: string; createdAt: string; read?: boolean; conversationId?: string }>>

export interface RemoteTabSnapshot {
  tabs: RemoteTabState[]
  resourceManifest: ResourceManifest
}

export async function getRemoteTabStates(): Promise<RemoteTabSnapshot> {
  let rendererResult: { tabs: any[]; resourceManifest: ResourceManifest } = { tabs: [], resourceManifest: {} }
  try {
    rendererResult = await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        try {
          // Inlined copy of tabHasExtensions (../../shared/tab-predicates).
          // This IIFE is evaluated in the RENDERER global scope via
          // executeJavaScript and CANNOT reference main-process imports —
          // calling the imported helper threw a ReferenceError on every poll,
          // silently degrading the snapshot to the cold-start path. The
          // predicate is pure (engineProfileId non-null, non-empty), so it is
          // safe to inline here. Keep this in sync with tab-predicates.ts.
          function tabHasExtensions(t) {
            return t.engineProfileId != null && t.engineProfileId !== '';
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
            // of ANY role, including a trailing tool run. Scanning only
            // user/assistant rows let a tab whose tail is a long tool sequence
            // report a stale timestamp and sink below idle tabs on iOS (and in
            // the desktop-side sort below). Take the max timestamp across all
            // rows so an actively-tool-working tab sorts as recently active.
            for (var ti = msgs.length - 1; ti >= 0; ti--) {
              var rowTs = msgs[ti].timestamp || 0;
              if (rowTs > lastTs) lastTs = rowTs;
              // Rows are appended in time order, so the last row generally holds
              // the max; but a re-keyed/edited row can carry an older stamp, so
              // we scan rather than trust position. Cheap: bounded by page size.
            }
            // Conversation tail fingerprint — the staleness signal for the iOS
            // main-conversation heal. iOS computes the SAME fingerprint over its
            // local tail and reloads when it diverges (dropped live deltas).
            // Computed via store.getState().computeConvFingerprint(tabId) which
            // calls the canonical conversationTailFingerprint() from
            // shared/conversation-fingerprint.ts — that function is the single
            // TS source of truth and is unit-tested separately. The Swift copy
            // (SessionViewModel+Snapshot.swift conversationTailFingerprint) must
            // remain byte-identical; any algorithm change starts there.
            var convFingerprint = (typeof s.computeConvFingerprint === 'function')
              ? (s.computeConvFingerprint(t.id) || '')
              : '';
            // Live interactive permission requests live on the active instance.
            var queue = (activeInst && activeInst.permissionQueue ? activeInst.permissionQueue : []).slice();
            // Live extension elicitations (ctx.elicit) also live on the active
            // instance; project them so iOS can render an approval card and the
            // run is not silently parked on a mobile client.
            var elicitQueue = (activeInst && activeInst.elicitationQueue ? activeInst.elicitationQueue : []).slice();
            // Promote the active instance's non-interactive denials into the
            // queue so the iOS card path (which keys off the tab-level queue)
            // works uniformly for every tab. An extension-hosted tab stamps the
            // promoted entry with instanceId so iOS can scope the card to the
            // owning sub-conversation; a plain conversation's single main
            // instance carries the denial and omits the scope (so the iOS
            // active-instance filter passes). The per-instance waitingState
            // (set below on conversationInstances[i]) drives the iOS sub-tab
            // pill; the parent pill glows because the denial is in the queue.
            // Running/connecting tabs have no outstanding permission question:
            // a genuine mid-run request arrives via the live permissionQueue /
            // permission_request path, not the stale permissionDenied residue.
            // permissionDenied is cleared lazily (only on next send when
            // !isBusy — send-slice.ts), so a running tab holds a resolved
            // denial and promoting it would re-inject a stale card on iOS on
            // every snapshot tick. Exclude running and connecting to prevent that.
            // TAB-TYPE-AGNOSTIC for idle/completed: a plain conversation can run
            // background sub-agents whose denials must still reach iOS after the
            // run finishes — do NOT weaken the idle/completed promotion path.
            if (activeInst && t.status !== 'failed' && t.status !== 'dead' && t.status !== 'running' && t.status !== 'connecting') {
              var pdEntry = activeInst.permissionDenied;
              var pdTools = pdEntry && pdEntry.tools;
              if (pdTools && pdTools.length > 0) {
                for (var pdi = 0; pdi < pdTools.length; pdi++) {
                  // TAB-TYPE-AGNOSTIC: every outstanding denial surfaces to the
                  // iOS card queue, plain or extension-hosted. A plain
                  // conversation can run background sub-agents that produce
                  // non-plan tool denials, so a completed plain conversation's
                  // denials must reach iOS too. (A prior filter dropped all but
                  // ExitPlanMode / AskUserQuestion denials for completed plain
                  // conversations — fixed.)
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
            // Log when a running/connecting tab's denial promotion is suppressed
            // so the skip is observable in desktop.log without ambiguity.
            if (activeInst && (t.status === 'running' || t.status === 'connecting')) {
              var pdSkipEntry = activeInst.permissionDenied;
              var pdSkipTools = pdSkipEntry && pdSkipEntry.tools;
              if (pdSkipTools && pdSkipTools.length > 0) {
                console.log('[snapshot] suppressed stale denial promotion tabId=' + t.id.slice(0, 8) + ' status=' + t.status + ' tools=' + pdSkipTools.map(function(p) { return p.toolName + '(' + p.toolUseId.slice(-8) + ')'; }).join(','));
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
            // Reuse the active-instance resolution from above. cPane is the
            // tab's conversation pane (every tab has one); list its instances
            // so iOS can render the per-sub-tab EngineInstanceBar.
            var ePaneForList = cPane;
            var conversationInstances = undefined;
            var activeConversationInstanceId = undefined;
            if (ePaneForList && ePaneForList.instances && ePaneForList.instances.length > 0) {
              // For each instance, derive its individual waitingState
              // from enginePermissionDenied so iOS can show a per-sub-tab
              // status dot in EngineInstanceBar. 'question' outranks
              // 'plan-ready' (matches desktop's getWaitingState helper).
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
                // Per-instance running state so iOS EngineInstanceBar can
                // show a pulsing dot on each running sub-tab. Parallels the
                // waitingState derivation above.
                var instRunning = false;
                var sf = inst.statusFields;
                if (sf) {
                  var st = sf.state;
                  instRunning = st === 'running' || st === 'connecting' || st === 'starting';
                }
                // Per-instance running-agent-count. Folds across both the
                // instance's agentStates field AND statusFields.backgroundAgents
                // to expose "how many dispatched background agents are still
                // running" to iOS. Takes the MAX (not sum) of both sources
                // because they observe the same underlying agents from two
                // vantage points — agentStates for extension-hosted orchestrators,
                // backgroundAgents for plain-conversation dispatches where
                // agentStates remains empty.
                // Keep in sync with effectiveRunningChildrenCount in
                // TabStripShared.ts — this IIFE cannot import that helper
                // (runs in renderer global scope via executeJavaScript; see the
                // tabHasExtensions inline-mirror precedent at lines 26-35).
                // Drives the yellow "awaiting children" pulse on the iOS
                // sub-tab pill and footer, mirroring the desktop's
                // agentCountByInstance derivation in EngineTabStrip.
                // Per CLAUDE.md § "Common parity surfaces" — when the
                // desktop renders a per-instance signal, iOS must see the
                // same data through the snapshot so the parity table row
                // can be honored.
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
                // Per-instance model-fallback indicator. Projects the
                // renderer's engineModelFallbacks map onto each instance
                // so iOS can render a matching ⚠ glyph on its
                // EngineInstanceBar. The desktop populates the source
                // map from engine_model_fallback events; we forward only
                // the requested + fallback model strings (no timestamp,
                // no reason — iOS doesn't need them to render the
                // indicator). When iOS's snapshot pull arrives with the
                // field omitted, the iOS indicator clears — matching the
                // desktop's clear-on-idle behaviour via the snapshot tick.
                // See CLAUDE.md § "Common parity surfaces" row for model
                // fallback indicator.
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
            // Parallel aggregate for "any instance has running background
            // children" — drives the iOS parent tab pill's yellow
            // "awaiting children" dot. Folds across the per-instance
            // runningAgentCount we just derived. See CLAUDE.md §
            // "Common parity surfaces" parity table row.
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
              // WI-001 landed at 8690aae3 makes t.status authoritative for every
              // conversation. The normalized arm writes status to the single main
              // instance with no active-instance gate, so t.status is never
              // stranded by an inactive sub-instance switch. The per-instance
              // status compensation block is retired; t.status projects uniformly
              // for all tabs.
              status: t.status,
              workingDirectory: t.workingDirectory,
              // All tab types store permissionMode on the active conversation
              // instance (WI-002). The activeInst resolution at the top of this
              // map callback is the single read source — no tab-type fork.
              permissionMode: (activeInst && activeInst.permissionMode) || 'auto',
              permissionQueue: queue,
              elicitationQueue: elicitQueue,
              // Per-conversation extended-thinking effort from the active instance.
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
              // Without this field, the badge falls back to literal "EXT".
              engineProfileId: t.engineProfileId || null,
              conversationInstances: conversationInstances,
              activeConversationInstanceId: activeConversationInstanceId,
              terminalInstances: terminalInstances,
              activeTerminalInstanceId: activeTerminalInstanceId,
              groupId: t.groupId || null,
              modelOverride: (activeInst && activeInst.modelOverride) || null,
              groupPinned: t.groupPinned || false,
              // Top-level aggregate of "any sub-instance has running
              // background children". iOS reads this on the parent tab
              // pill so the yellow "awaiting children" dot fires without
              // folding across conversationInstances client-side. Mirrors the
              // desktop's anyEngineInstanceHasRunningChildren helper.
              hasRunningChildren: anyInstanceHasRunningChildren || undefined,
              conversationId: t.conversationId || null,
              lastMessageContent: lastMsg,
              lastActivityTs: lastTs || 0,
              convFingerprint: convFingerprint,
              pillColor: t.pillColor || null,
              pillIcon: t.pillIcon || null,
              // ─── Cold-start parity: cost + token fields ───────────────────
              // Projected from the active-instance statusFields and lastResult
              // so iOS has accurate cost/token data on cold open without
              // waiting for a live engine_status event. These match the fields
              // RemoteTabState added in the snapshot-parity fix.
              //
              // runCostUsd: prefer the live run-scoped cost from statusFields;
              //   fall back to the final task_complete cost from lastResult.
              //   Omitted when neither is present (never-run tabs).
              runCostUsd: (function() {
                var liveCost = activeInst && activeInst.statusFields && typeof activeInst.statusFields.runCostUsd === 'number' ? activeInst.statusFields.runCostUsd : undefined;
                if (liveCost !== undefined) return liveCost;
                return t.lastResult && typeof t.lastResult.totalCostUsd === 'number' ? t.lastResult.totalCostUsd : undefined;
              })(),
              conversationCostUsd: (activeInst && activeInst.statusFields && typeof activeInst.statusFields.conversationCostUsd === 'number') ? activeInst.statusFields.conversationCostUsd : undefined,
              // conversationTurns: lifetime prompt count from the final
              // task_complete (lastResult). Prefer the live status field when
              // present; fall back to lastResult so historical/idle tabs still
              // carry it. Omitted when neither is present (never-run tabs).
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
          // Never fail silently. This IIFE runs in the renderer, so
          // console.error is forwarded to ~/.ion/desktop.log via the
          // renderer-console handler. A throw here degrades EVERY snapshot
          // to the cold-start path (missing groupId / pillColor /
          // conversationInstances), so it must be observable. The original
          // ReferenceError (calling a main-process import inside this IIFE)
          // went undetected for exactly this reason.
          console.error('[snapshot] IIFE failed, falling back to cold-start: ' + (e && e.message ? e.message : String(e)));
          return { tabs: [], resourceManifest: {} };
        }
      })()
    `) || { tabs: [], resourceManifest: {} }
  } catch {
    rendererResult = { tabs: [], resourceManifest: {} }
  }

  const rendererTabs = rendererResult.tabs
  let resourceManifest: ResourceManifest = rendererResult.resourceManifest || {}

  // Fallback: if the renderer store is empty (desktop just restarted,
  // subscription hasn't resolved yet), read resource metadata from disk.
  // The extension persists resources to ~/.ion/resources/global/*.json.
  if (Object.keys(resourceManifest).length === 0) {
    try {
      const globalDir = join(homedir(), '.ion', 'resources', 'global')
      if (existsSync(globalDir)) {
        const files = readdirSync(globalDir).filter(f => f.endsWith('.json'))
        if (files.length > 0) {
          const items: Array<{ id: string; kind: string; title?: string; createdAt: string; read?: boolean }> = []
          for (const f of files) {
            try {
              const data = JSON.parse(readFileSync(join(globalDir, f), 'utf-8'))
              if (data.id && data.kind) {
                items.push({ id: data.id, kind: data.kind, title: data.title, createdAt: data.createdAt || '', read: isResourceRead(data.id) })
              }
            } catch { /* skip corrupt files */ }
          }
          if (items.length > 0) {
            const byKind: ResourceManifest = {}
            for (const item of items) {
              if (!byKind[item.kind]) byKind[item.kind] = []
              byKind[item.kind].push(item)
            }
            resourceManifest = byKind
            log('desktop_snapshot', 'resource manifest cold-loaded from disk', { items: items.length })
          }
        }
      }
    } catch { /* disk read failure is non-fatal */ }
  }

  // Apply persisted read state from the main process. The renderer's
  // readResourceIds may be stale or empty after restart. The main-process
  // persistence file (~/.ion/resource-read-state.json) is the source of truth.
  for (const kind of Object.keys(resourceManifest)) {
    for (const item of resourceManifest[kind]) {
      if (isResourceRead(item.id)) {
        item.read = true
      }
    }
  }

  if (rendererTabs.length > 0) {
    // Log any tabs carrying a non-empty permissionQueue so we can confirm
    // the blue-dot data survives iOS relaunch.
    for (const t of rendererTabs) {
      if (t.permissionQueue?.length > 0) {
        const qIds = (t.permissionQueue || []).map((p: any) => `${p.toolTitle || p.toolName}(${p.questionId?.slice(-8)})`).join(', ')
        debug('desktop_snapshot', 'tab state', { tab_id: t.id?.slice(0, 8), status: t.status, perm_queue: qIds })
      }
    }
    const mapped = rendererTabs
      .map((t: any) => {
        // Resolve impure inputs first, then delegate to the pure projection helper.
        // The helper owns the field-mapping contract; callers here handle side effects.
        const permissionQueue = (t.permissionQueue || []).map((p: any) => {
          const entry = {
            questionId: p.questionId,
            toolName: p.toolTitle || '',
            toolInput: p.toolInput,
            options: (p.options || []).map((o: any) => ({
              id: o.optionId,
              kind: o.kind,
              label: o.label,
            })),
            // Carry the engine-instance scoping through the main-process
            // mapping so it survives onto the wire. Undefined for CLI
            // tabs and for renderer queue entries that predate the field.
            instanceId: p.instanceId || undefined,
          }
          // Enrich ExitPlanMode entries with metadata for the iOS plan card.
          // The plan file body is NOT embedded in the snapshot (too expensive —
          // sync disk I/O on every 5 s poll tick for every ExitPlanMode entry).
          // iOS fetches plan content on demand via desktop_request_plan_content
          // when the user expands the card. planFilePath is preserved on the entry
          // so iOS knows how to request it. See commit 7 and plan-content-cache.ts.
          if (entry.toolName === 'ExitPlanMode') {
            // No preview embedding — omit the sync readPlanPreviewCached call.
            // iOS gracefully handles a missing planContentPreview by showing a
            // "tap to load" placeholder and fetching on expand.
          }
          return entry
        })
        // Map the active instance's elicitation queue onto the wire shape. The
        // renderer entry already matches ElicitationRequest, so this is a
        // straight projection (defensive copy keeps the snapshot pure).
        const elicitationQueue = (t.elicitationQueue || []).map((e: any) => ({
          requestId: e.requestId,
          mode: e.mode || '',
          schema: e.schema,
          url: e.url,
        }))
        const lastMessage = t.lastMessageContent || lastMessagePreview.get(t.id) || null
        // Pure field projection — contract pinned by snapshot-project.ts and
        // tested in __tests__/snapshot-project.test.ts. Visual diff here vs.
        // that file to verify the two stay in sync.
        return projectRendererTab(t, { lastMessage, permissionQueue, elicitationQueue })
      })

    mapped.sort((a, b) => {
      const aRunning = a.status === 'running' || a.status === 'connecting' ? 1 : 0
      const bRunning = b.status === 'running' || b.status === 'connecting' ? 1 : 0
      if (aRunning !== bRunning) return bRunning - aRunning
      return (b.lastActivityAt || 0) - (a.lastActivityAt || 0)
    })

    return { tabs: mapped, resourceManifest }
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
      // Cold-start best-effort: read the persisted main-instance count from the
      // unified conversationPane when present (post-migration shape). Corrected
      // on the first real store-backed snapshot.
      const coldMain = t.conversationPane?.instances?.find((x: any) => x.id === 'main') ?? t.conversationPane?.instances?.[0]
      results.push({
        id: h?.tabId || `persisted-${i}`,
        title: t.customTitle || t.title || `Tab ${i + 1}`,
        customTitle: t.customTitle || null,
        status: (h?.status || 'idle') as TabStatus,
        workingDirectory: t.workingDirectory || '',
        // Prefer the instance-persisted mode (WI-002). Fall back to the legacy
        // tab-level field for tabs.json written before WI-002.
        permissionMode: ((coldMain?.permissionMode || t.permissionMode) === 'plan' ? 'plan' : 'auto') as 'auto' | 'plan',
        permissionQueue: [],
        lastMessage: null,
        contextTokens: t.contextTokens || null,
        contextWindow: t.contextWindow ?? null,
        messageCount: coldMain?.messageCount ?? 0,
        queuedPrompts: t.queuedPrompts || [],
        modelOverride: coldMain?.modelOverride ?? null,
        lastActivityAt: h?.lastActivityAt || undefined,
        // Omit convFingerprint on the cold path — do NOT send ''. iOS compares
        // the snapshot fingerprint against its real local tail; an empty string
        // never matches a non-empty local fingerprint, so sending '' forces an
        // authoritative history reload on every cold snapshot (and can thrash if
        // cold snapshots recur during a slow renderer start). Absent means
        // "nothing to compare" on iOS, which is the correct cold-start behavior:
        // the next store-backed snapshot carries the real fingerprint. (RC-4)
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
        contextWindow: null,
        messageCount: 0,
        queuedPrompts: [],
        lastActivityAt: t.lastActivityAt || undefined,
        // Omit on the cold path — see the RC-4 note above; '' forces an iOS
        // reload loop, absent is the correct "nothing to compare" signal.
      })
    }
  }

  results.sort((a, b) => {
    const aRunning = a.status === 'running' || a.status === 'connecting' ? 1 : 0
    const bRunning = b.status === 'running' || b.status === 'connecting' ? 1 : 0
    if (aRunning !== bRunning) return bRunning - aRunning
    return (b.lastActivityAt || 0) - (a.lastActivityAt || 0)
  })

  return { tabs: results, resourceManifest: {} }
}
