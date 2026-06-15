import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { state, sessionPlane, lastMessagePreview } from '../state'
import { TABS_FILE } from '../settings-store'
import { isResourceRead } from '../event-wiring-resources'
import { log } from '../logger'
import type { RemoteTabState } from './protocol'
import type { TabStatus } from '../../shared/types'

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
            for (var i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === 'assistant' || msgs[i].role === 'user') {
                lastMsg = (msgs[i].content || '').substring(0, 100);
                lastTs = msgs[i].timestamp || 0;
                break;
              }
            }
            // Live interactive permission requests live on the active instance.
            var queue = (activeInst && activeInst.permissionQueue ? activeInst.permissionQueue : []).slice();
            // Promote the active instance's non-interactive denials into the
            // queue so the iOS card path (which keys off the tab-level queue)
            // works uniformly for every tab. An extension-hosted tab stamps the
            // promoted entry with instanceId so iOS can scope the card to the
            // owning sub-conversation; a plain conversation's single main
            // instance carries the denial and omits the scope (so the iOS
            // active-instance filter passes). The per-instance waitingState
            // (set below on conversationInstances[i]) drives the iOS sub-tab
            // pill; the parent pill glows because the denial is in the queue.
            if (activeInst && t.status !== 'failed' && t.status !== 'dead') {
              var pdEntry = activeInst.permissionDenied;
              var pdTools = pdEntry && pdEntry.tools;
              if (pdTools && pdTools.length > 0) {
                for (var pdi = 0; pdi < pdTools.length; pdi++) {
                  // A completed PLAIN conversation only surfaces ExitPlanMode /
                  // AskUserQuestion denials (historical filter); an
                  // extension-hosted instance surfaces all of its denials.
                  if (!t.hasEngineExtension && t.status === 'completed' &&
                      pdTools[pdi].toolName !== 'ExitPlanMode' &&
                      pdTools[pdi].toolName !== 'AskUserQuestion') continue;
                  var pdEntryOut = {
                    questionId: 'denied-' + pdTools[pdi].toolUseId,
                    toolName: pdTools[pdi].toolName,
                    toolTitle: pdTools[pdi].toolName,
                    toolInput: pdTools[pdi].toolInput,
                    options: []
                  };
                  if (t.hasEngineExtension) pdEntryOut.instanceId = activeInstId;
                  queue.push(pdEntryOut);
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
                // Per-instance running-agent-count. Folds across the
                // instance's agentStates field to expose "how many
                // dispatched background agents are still running" to iOS.
                // Drives the yellow "awaiting children" pulse on the iOS
                // sub-tab pill and footer, mirroring the desktop's
                // agentCountByInstance derivation in EngineTabStrip.
                // Per CLAUDE.md § "Common parity surfaces" — when the
                // desktop renders a per-instance signal, iOS must see the
                // same data through the snapshot so the parity table row
                // can be honored.
                var instRunningAgents = 0;
                var ags = inst.agentStates;
                if (ags && Array.isArray(ags)) {
                  for (var ai = 0; ai < ags.length; ai++) {
                    if (ags[ai] && ags[ai].status === 'running') instRunningAgents++;
                  }
                }
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
                return { id: inst.id, label: inst.label, waitingState: ws, isRunning: instRunning || undefined, runningAgentCount: instRunningAgents > 0 ? instRunningAgents : undefined, modelFallback: mfOut, conversationIds: inst.conversationIds && inst.conversationIds.length > 0 ? inst.conversationIds : undefined };
              });
              activeConversationInstanceId = ePaneForList.activeInstanceId || ePaneForList.instances[0].id;
            }
            // Aggregate running state across all engine instances so the
            // iOS tab-list dot pulses when ANY instance is running, even
            // if the active instance is idle. Parallels the desktop's
            // isAnyEngineInstanceRunning helper in TabStripShared.ts.
            var anyInstanceRunning = false;
            // Parallel aggregate for "any instance has running background
            // children" — drives the iOS parent tab pill's yellow
            // "awaiting children" dot. Folds across the per-instance
            // runningAgentCount we just derived. See CLAUDE.md §
            // "Common parity surfaces" parity table row.
            var anyInstanceHasRunningChildren = false;
            if (conversationInstances) {
              for (var ei = 0; ei < conversationInstances.length; ei++) {
                if (conversationInstances[ei].isRunning) anyInstanceRunning = true;
                if ((conversationInstances[ei].runningAgentCount || 0) > 0) anyInstanceHasRunningChildren = true;
                if (anyInstanceRunning && anyInstanceHasRunningChildren) break;
              }
            }
            // Derive the parent engine tab's status authoritatively from
            // per-instance state. The renderer's t.status can be stale
            // for engine tabs: the engine_status / engine_text_delta
            // handlers gate writes on the *active* sub-instance, so an
            // inactive sub-instance that started running and then finished
            // (or a user switching active sub-instances mid-run) can strand
            // t.status === 'running' even when no sub-instance is
            // actually running anymore. Without this derivation, iOS
            // receives the stranded value via the snapshot and shows the
            // parent tab pulsing orange + "Running…" indefinitely.
            //
            // Rules (engine tabs only):
            //   - anyInstanceRunning → 'running'
            //   - terminal status ('dead' / 'failed') → preserve
            //   - 'completed' AND queue carries ExitPlanMode/AskUserQuestion
            //     → preserve 'completed' so the green (plan-ready) /
            //     blue (question) parent pill still shows after auto-allow
            //   - otherwise → 'idle'
            //
            // Non-engine tabs pass through t.status unchanged.
            //
            // Desktop's own tab pill is unaffected: it reads
            // isAnyEngineInstanceRunning(tab.id) directly in
            // TabStripShared.ts line ~415, never trusting tab.status for
            // engine running-state. This derivation is purely for the
            // snapshot projection consumed by iOS.
            //
            // SYNC NOTE. The inline implementation below MUST match
            // the pure deriveEngineParentStatus helper in
            // snapshot-derive.ts. The helper is the canonical contract
            // (pinned by __tests__/snapshot-derive.test.ts); the inline
            // copy here exists because this IIFE runs in renderer
            // process via executeJavaScript and cannot import from
            // main-process modules. Reviewers verify by visual diff.
            var derivedStatus = t.status;
            if (t.hasEngineExtension === true) {
              if (anyInstanceRunning) {
                derivedStatus = 'running';
              } else if (t.status === 'dead' || t.status === 'failed') {
                derivedStatus = t.status;
              } else if (t.status === 'completed') {
                var hasWaitingDenial = false;
                for (var qi = 0; qi < queue.length; qi++) {
                  var qTool = queue[qi] && (queue[qi].toolTitle || queue[qi].toolName);
                  if (qTool === 'ExitPlanMode' || qTool === 'AskUserQuestion') { hasWaitingDenial = true; break; }
                }
                derivedStatus = hasWaitingDenial ? 'completed' : 'idle';
              } else {
                derivedStatus = 'idle';
              }
              // Log every downgrade from running/connecting → idle so a
              // future investigation can confirm the derivation fired and
              // identify the tab. Logged in the renderer (console.log)
              // because this IIFE runs in the renderer process. The
              // main-process log() helper is not in scope here.
              if ((t.status === 'running' || t.status === 'connecting') && derivedStatus !== 'running' && derivedStatus !== 'connecting') {
                console.log('[snapshot] engine parent tab status downgrade tabId=' + (t.id || '').slice(0, 8) + ' raw=' + t.status + ' derived=' + derivedStatus + ' anyInstanceRunning=' + anyInstanceRunning + ' queueLen=' + queue.length);
              }
            }
            return {
              id: t.id,
              title: t.title,
              customTitle: t.customTitle,
              status: derivedStatus,
              workingDirectory: t.workingDirectory,
              permissionMode: (function() {
                // Extension-hosted: each sub-conversation has its own mode, so
                // the active instance is authoritative. Plain: permissionMode
                // is a tab-level setting (t.permissionMode).
                if (t.hasEngineExtension) {
                  return (activeInst && activeInst.permissionMode) || 'auto';
                }
                return t.permissionMode;
              })(),
              permissionQueue: queue,
              contextTokens: t.contextTokens,
              contextWindow: t.contextWindow ?? null,
              messageCount: (msgs.length > 0 ? msgs.length : (activeInst && activeInst.messageCount) || 0),
              queuedPrompts: t.queuedPrompts || [],
              isTerminalOnly: t.isTerminalOnly || undefined,
              hasEngineExtension: t.hasEngineExtension || undefined,
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
              pillColor: t.pillColor || null,
              pillIcon: t.pillIcon || null,
            };
          });
          return { tabs: tabs, resourceManifest: resourceManifest };
        } catch(e) { return { tabs: [], resourceManifest: {} }; }
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
            log('snapshot', `resource manifest cold-loaded from disk: ${items.length} items`)
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
            // Carry the engine-instance scoping through the main-process
            // mapping so it survives onto the wire. Undefined for CLI
            // tabs and for renderer queue entries that predate the field.
            instanceId: p.instanceId || undefined,
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
        contextWindow: t.contextWindow ?? null,
        messageCount: t.messageCount || 0,
        queuedPrompts: t.queuedPrompts || [],
        isTerminalOnly: t.isTerminalOnly || undefined,
        hasEngineExtension: t.hasEngineExtension || undefined,
        conversationInstances: t.conversationInstances || undefined,
        activeConversationInstanceId: t.activeConversationInstanceId || undefined,
        terminalInstances: t.terminalInstances || undefined,
        activeTerminalInstanceId: t.activeTerminalInstanceId || undefined,
        groupId: t.groupId || null,
        modelOverride: t.modelOverride || null,
        groupPinned: t.groupPinned || false,
        hasRunningChildren: t.hasRunningChildren || undefined,
        conversationId: t.conversationId || undefined,
        lastActivityAt: t.lastActivityTs || undefined,
        pillColor: t.pillColor || null,
        pillIcon: t.pillIcon || null,
      }))

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
        permissionMode: (t.permissionMode === 'plan' ? 'plan' : 'auto') as 'auto' | 'plan',
        permissionQueue: [],
        lastMessage: null,
        contextTokens: t.contextTokens || null,
        contextWindow: t.contextWindow ?? null,
        messageCount: coldMain?.messageCount ?? 0,
        queuedPrompts: t.queuedPrompts || [],
        modelOverride: coldMain?.modelOverride ?? null,
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
        contextWindow: null,
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

  return { tabs: results, resourceManifest: {} }
}
