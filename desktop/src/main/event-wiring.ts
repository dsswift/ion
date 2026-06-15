import { IPC } from '../shared/types'
import type { NormalizedEvent, EnrichedError } from '../shared/types'
import { log as _log } from './logger'
import { state, sessionPlane, engineBridge, extensionCommandRegistry, forwardedEnginePermissionDenials, lastForwardedEngineTabStatus } from './state'
import { broadcast } from './broadcast'
import { currentBackend } from './settings-store'
import { formatClearDivider } from '../shared/clear-divider'
import { tabIdFromKey } from '../shared/session-key'
import { subscribeToResourceKinds, subscribeToGlobalResourceKinds, clearResourceSubscriptions, markReadPersisted, resubscribeSessionResourceKinds } from './event-wiring-resources'
import { handleInterceptEvent } from './event-wiring-intercept'
import { injectDiskResourcesIfEmpty } from './event-wiring-disk-seed'
export { wireTabFocusHandler, wireMarkResourceReadHandler, wireDeleteResourceHandler } from './event-wiring-resources'
export { wireRemoteSessionPlaneForwarding } from './event-wiring-remote'

function log(msg: string): void {
  _log('main', msg)
}

export function wireSessionPlaneEvents(): void {
  sessionPlane.on('event', (tabId: string, event: NormalizedEvent) => {
    broadcast('ion:normalized-event', tabId, event)
  })

  sessionPlane.on('tab-status-change', (tabId: string, newStatus: string, oldStatus: string) => {
    broadcast('ion:tab-status-change', tabId, newStatus, oldStatus)
  })

  sessionPlane.on('error', (tabId: string, error: EnrichedError) => {
    broadcast('ion:enriched-error', tabId, error)
  })

  // engine_intercept from CLI-tab sessions. EngineControlPlane bubbles
  // engine_intercept up via ctx.emit('engine_intercept', tabId, event)
  // rather than emitting it as a NormalizedEvent (it's not one). The
  // intercept handler does device-focus routing, optional abort/re-prompt,
  // and renderer broadcast.
  sessionPlane.on('engine_intercept', (tabId: string, event: any) => {
    handleInterceptEvent(tabId, event).catch((err: unknown) => {
      log(`wireSessionPlaneEvents: intercept handler error tabId=${tabId}: ${(err as Error).message}`)
    })
  })
}

export function wireEngineBridgeEvents(): void {
  // ---------------------------------------------------------------------------
  // Text-delta batching: accumulate engine_text_delta events per key and
  // flush at ~60fps (16ms interval) to reduce Electron IPC crossings from
  // 50-200/sec per key to ~60/sec. Each IPC call involves structured-clone
  // serialization across the process boundary; coalescing small deltas into
  // larger chunks significantly reduces serialization + deserialization CPU.
  // ---------------------------------------------------------------------------
  const pendingTextDeltas = new Map<string, string>()
  let deltaFlushTimer: ReturnType<typeof setInterval> | null = null

  function flushTextDeltas(): void {
    if (pendingTextDeltas.size === 0) return
    for (const [deltaKey, text] of pendingTextDeltas) {
      broadcast(IPC.ENGINE_EVENT, deltaKey, { type: 'engine_text_delta', text })
      if (state.remoteTransport) {
        // Wire-key (Key A) parsing for iOS forwarding — NOT renderer pane
        // addressing. The `|| null` is load-bearing: a plain conversation's
        // wire key is bare (→ instanceId null), an extension-hosted instance's
        // is compound (→ its instanceId). iOS depends on this null vs id
        // distinction, so do NOT convert this to parseSessionKey (which would
        // map bare → 'main' and change the forwarded wire shape).
        const dtabId = deltaKey.split(':')[0]
        const dinstanceId = deltaKey.split(':')[1] || null
        state.remoteTransport.send({ type: 'engine_text_delta', tabId: dtabId, instanceId: dinstanceId, text })
      }
    }
    pendingTextDeltas.clear()
  }

  function ensureDeltaFlushTimer(): void {
    if (!deltaFlushTimer) {
      deltaFlushTimer = setInterval(flushTextDeltas, 16)
    }
  }

  // Subscribe to global resources on every (re)connect. The engine_command_registry
  // event only fires once during initial session creation; reconnects to a running
  // engine see "already exists" and skip the registry emission. Without this,
  // resource subscriptions are never re-established after a desktop restart.
  const subscribeGlobalResources = () => {
    clearResourceSubscriptions()
    log('engineBridge: subscribing to global resources')
    subscribeToGlobalResourceKinds().catch((err) => {
      log(`resource_subscribe_global: error on connect err=${err}`)
    })
    // Re-establish per-session subscriptions for sessions that were active
    // before the reconnect. engine_command_registry only fires on initial
    // session creation; reconnects skip it.
    resubscribeSessionResourceKinds().catch((err) => {
      log(`resource_subscribe: resubscribe error on connect err=${err}`)
    })
  }
  engineBridge.on('reconnected', subscribeGlobalResources)

  // Track whether we've done the initial global resource subscription.
  // The first engine event signals the bridge is live. Fire once.
  let initialSubscribeDone = false

  engineBridge.on('event', (key: string, event: any) => {
    if (!initialSubscribeDone) {
      initialSubscribeDone = true
      subscribeGlobalResources()
    }
    if (event.type === 'engine_status' && event.fields) {
      event = { ...event, fields: { ...event.fields, backend: currentBackend } }
    }

    // engine_command_registry: refresh the main-process routing-hint cache
    // BEFORE broadcasting so the unified prompt pipeline always observes the
    // newest snapshot if a slash command is dispatched in the same tick.
    // Snapshot semantics — see state.ts comment on extensionCommandRegistry.
    if (event.type === 'engine_command_registry') {
      const listings = Array.isArray(event.commands) ? event.commands : []
      if (listings.length === 0) {
        // Empty list is the authoritative "no extension commands" signal —
        // drop the entry entirely so a future re-populate sees a clean slot
        // and routing-hint MISSes correctly trigger the engine-resolved
        // backstop. Leaving an empty Set in the map would be observationally
        // identical but harder to reason about in logs.
        const had = extensionCommandRegistry.has(key)
        extensionCommandRegistry.delete(key)
        log(`engine_command_registry: cleared key=${key} (was=${had})`)
      } else {
        const names = new Set<string>(listings.map((l: { name: string }) => l.name))
        extensionCommandRegistry.set(key, names)
        log(`engine_command_registry: cached key=${key} count=${names.size} names=[${[...names].join(',')}]`)
      }
      // Extensions are loaded — subscribe to resource kinds now. The
      // command_registry event fires after the extension process has
      // declared its resource kinds, so the broker is ready to serve
      // subscription requests. Idempotent: subscribeToResourceKinds
      // skips kinds already subscribed for this session key.
      subscribeToResourceKinds(key).catch((err) => {
        log(`resource_subscribe: error key=${key} err=${err}`)
      })
      // Also subscribe to global resource kinds (workspace-scoped).
      // Idempotent: subscribeToGlobalResourceKinds skips already-subscribed kinds.
      subscribeToGlobalResourceKinds().catch((err) => {
        log(`resource_subscribe_global: error err=${err}`)
      })
    }

    // engine_intercept: route through the intercept handler which checks
    // device focus, per-device and desktop preferences, and performs
    // targeted iOS forwarding + optional abort/re-prompt. Skip the generic
    // broadcast and generic iOS send below — the handler does both.
    if (event.type === 'engine_intercept') {
      const tabId = tabIdFromKey(key)
      handleInterceptEvent(tabId, event).catch((err: unknown) => {
        log(`engine_intercept: handler error key=${key}: ${(err as Error).message}`)
      })
      return
    }

    // engine_text_delta: accumulate into the batch buffer instead of
    // broadcasting immediately. The 16ms flush timer coalesces multiple
    // small deltas (50-200/sec) into ~60 larger chunks/sec, cutting IPC
    // serialization overhead by 3-4x. iOS forwarding is also deferred.
    if (event.type === 'engine_text_delta') {
      pendingTextDeltas.set(key, (pendingTextDeltas.get(key) || '') + (event.text || ''))
      ensureDeltaFlushTimer()
      return
    }

    broadcast(IPC.ENGINE_EVENT, key, event)

    // Resource event observability
    if (event.type === 'engine_resource_snapshot') {
      const items = event.resourceItems ?? []
      log(`resource: snapshot key=${key} kind=${event.resourceKind} subId=${event.resourceSubId} items=${items.length} ids=[${items.slice(0, 3).map((i: any) => i.id?.slice(-8)).join(',')}${items.length > 3 ? '...' : ''}]`)
      // Cold-start disk seed: inject persisted items when the engine delivers
      // an empty snapshot (e.g. extension died during HandleQuery).
      if (items.length === 0 && state.mainWindow) {
        injectDiskResourcesIfEmpty(event.resourceKind, event.resourceSubId, key)
      }
    }
    if (event.type === 'engine_resource_delta') {
      const d = event.resourceDelta
      log(`resource: delta key=${key} kind=${event.resourceKind} op=${d?.op} id=${d?.item?.id?.slice(-8)} convId=${d?.item?.conversationId ?? 'global'}`)
    }

    // Persist mark_read deltas to disk so the desktop's read state survives
    // restarts and stays consistent with cross-device reads from iOS.
    // The renderer updates its in-memory readResourceIds on the same delta;
    // the main process writes through to ~/.ion/resource-read-state.json.
    if (
      event.type === 'engine_resource_delta' &&
      event.resourceDelta?.op === 'mark_read' &&
      event.resourceDelta?.item?.id
    ) {
      markReadPersisted(event.resourceDelta.item.id)
    }

    // Trace agent_state so we can correlate engine→desktop→iOS flow when
    // diagnosing stuck-row, stale-snapshot, or missing-conversation reports.
    // Pairs with the engine's `agent_snapshot_emitted` utils.Log line.
    // Always log — not gated on remoteTransport — so desktop.log is
    // sufficient for diagnosis even without an iOS device connected.
    if (event.type === 'engine_agent_state') {
      const agents = Array.isArray(event.agents) ? event.agents : []
      const statuses = agents.map((a: any) => `${a.name}:${a.status}`).join(',')
      log(`engineBridge: agent_state key=${key} count=${agents.length} statuses=[${statuses}]`)
      // Log dispatch metadata for terminal agents so we can verify
      // conversationId survives the engine→desktop pipeline.
      for (const a of agents) {
        if ((a.status === 'done' || a.status === 'error') && a.metadata?.task) {
          const meta = a.metadata
          log(`engineBridge: dispatch_agent name=${a.name} status=${a.status} convId=${meta.conversationId ?? 'MISSING'} convIds=${JSON.stringify(meta.conversationIds ?? 'MISSING')} convIdsType=${typeof meta.conversationIds}`)
        }
      }
    }

    if (state.remoteTransport) {
      // Wire-key (Key A) parsing for iOS forwarding — NOT renderer pane
      // addressing. `|| null` is load-bearing: bare wire key (plain
      // conversation) → null; compound (extension-hosted instance) → its
      // instanceId. iOS depends on this distinction; do NOT convert to
      // parseSessionKey (it would map bare → 'main').
      const tabId = key.split(':')[0]
      const instanceId = key.split(':')[1] || null
      // Every engine event the desktop sees gets forwarded to iOS, with
      // no per-event filtering. The previous special case that skipped
      // engine_early_stop_decision_request was removed once iOS gained
      // a decoder for it (see ios/IonRemote/Models/NormalizedEvent.swift
      // and the contract test in ContractSyncTests.swift). iOS observes
      // the event for diagnostic visibility only — the desktop is the
      // authoritative responder via early-stop-policy.ts — but the wire
      // protocol is now uniform across consumers.
      state.remoteTransport.send({ type: `engine_${event.type.replace('engine_', '')}`, tabId, instanceId, ...event })

      // Synthesize a `permission_request` envelope for iOS when an
      // engine-view `engine_status` event carries AskUserQuestion or
      // ExitPlanMode denials. The CLI/sessionPlane path forwards these
      // from `task_complete` in wireRemoteSessionPlaneForwarding above,
      // but engine-view events never reach sessionPlane (key mismatch:
      // EngineControlPlane is keyed by bare tabId, engine events arrive
      // with `tabId:instanceId`). Without this block, iOS receives the
      // engine_status itself (forwarded above) but has no decoder for
      // `permissionDenials` inside it — the card-rendering path on iOS
      // is keyed off `permission_request`. See plan-section "Files to
      // modify → event-wiring.ts" for the cross-reference.
      //
      // Dedupe via forwardedEnginePermissionDenials: engine_status fires
      // repeatedly, so without a guard every cost-only tick would re-push
      // the same envelope and re-fire the iOS push notification.
      if (event.type === 'engine_status' && Array.isArray(event.fields?.permissionDenials) && event.fields.permissionDenials.length > 0 && instanceId) {
        for (const denial of event.fields.permissionDenials) {
          if (denial.toolName !== 'AskUserQuestion' && denial.toolName !== 'ExitPlanMode') continue
          const questionId = `denied-${denial.toolUseId}`
          if (forwardedEnginePermissionDenials.has(questionId)) {
            // Already pushed for this toolUseId — skip silently. We hit
            // this path on every cost-only engine_status tick after the
            // initial denial-carrying tick.
            continue
          }
          forwardedEnginePermissionDenials.add(questionId)
          // Cap the dedup set to prevent unbounded growth. The set stores
          // one entry per permission denial ever forwarded; power users
          // can generate thousands over a long session. When the cap is
          // hit, clear the entire set — false-positive re-forwards are
          // harmless (just a duplicate push notification).
          if (forwardedEnginePermissionDenials.size > 1000) {
            forwardedEnginePermissionDenials.clear()
            forwardedEnginePermissionDenials.add(questionId)
          }
          const pushBody = denial.toolName === 'AskUserQuestion'
            ? 'Question waiting for your answer'
            : 'Plan ready for your review'
          log(`engine_status: forwarding ${denial.toolName} denial to remote key=${key} questionId=${questionId}`)
          // Stamp the engine instance (sub-tab) onto the envelope so iOS
          // can scope the plan/question card to the owning
          // sub-conversation instead of rendering it on every sibling
          // sub-tab under the same parent tab. `instanceId` is non-null
          // here — the enclosing guard requires it.
          state.remoteTransport.send({
            type: 'permission_request',
            tabId,
            instanceId,
            questionId,
            toolName: denial.toolName,
            toolInput: denial.toolInput,
            options: [],
          }, true, { title: 'Ion needs your attention', body: pushBody })
        }
      }

      // Synthesize a `tab_status` event for iOS when an engine-view
      // `engine_status` reports a state transition. Engine-view events
      // bypass EngineControlPlane (compound-key mismatch), so no
      // `tab-status-change` fires on the sessionPlane — iOS never learns
      // the tab moved from 'running' to 'idle'/'completed'. The desktop
      // renderer handles this locally in engine-event-slice.ts, but iOS
      // depends on explicit `tab_status` messages.
      //
      // Mirrors engine-control-plane-events.ts:handleStatusEvent logic:
      //   - idle + AskUserQuestion/ExitPlanMode denials → 'completed'
      //   - idle (no denials) → 'idle'
      //   - running → 'running'
      //
      // Deduped via lastForwardedEngineTabStatus to avoid flooding on
      // cost-only ticks (engine_status fires repeatedly with the same
      // state while the run is in progress or idling).
      if (event.type === 'engine_status' && event.fields?.state && instanceId) {
        const fieldState = event.fields.state as string
        let derivedStatus: string | null = null
        if (fieldState === 'idle') {
          const hasInteresting = Array.isArray(event.fields.permissionDenials) &&
            event.fields.permissionDenials.some(
              (d: { toolName: string }) => d.toolName === 'ExitPlanMode' || d.toolName === 'AskUserQuestion',
            )
          derivedStatus = hasInteresting ? 'completed' : 'idle'
        } else if (fieldState === 'running') {
          derivedStatus = 'running'
        }
        if (derivedStatus && lastForwardedEngineTabStatus.get(tabId) !== derivedStatus) {
          lastForwardedEngineTabStatus.set(tabId, derivedStatus)
          log(`engine_status: synthesizing tab_status for remote tabId=${tabId} instance=${instanceId} derivedStatus=${derivedStatus}`)
          state.remoteTransport.send({ type: 'tab_status', tabId, status: derivedStatus as any })
        }
      }

      // /clear success → relay an iOS-renderable divider so the mobile
      // client sees the checkpoint immediately. We piggy-back on the
      // existing envelopes iOS already decodes: `engine_harness_message`
      // for engine tabs (NormalizedEvent.engineHarnessMessage handler),
      // `message_added` for CLI tabs. Without this relay iOS would have
      // to learn a new event type to render the divider; using the
      // existing ones means iOS works without any Swift change.
      //
      // The renderer (engine-event-slice.ts) draws its own divider from
      // the same engine_command_result event, so desktop and iOS both
      // light up from a single engine signal.
      if (event.type === 'engine_command_result' && event.command === 'clear' && !event.commandError) {
        // The engine successfully cleared the conversation. Advance the
        // desktop's freshness checkpoint so the next slash command on this
        // tab is treated as the first prompt of a blank conversation by
        // `isFirstPromptForTab` in slash-classify.ts. The engine
        // intentionally keeps `s.conversationID` set (/clear is a
        // checkpoint, not a session restart) — without this notification
        // the post-/clear slash would see `promptCountSinceCheckpoint > 0`
        // and incorrectly preserve plan mode.
        log(`engine_command_result clear: notifying conversationCleared tabId=${tabId}`)
        sessionPlane.notifyConversationCleared(tabId)

        const divider = formatClearDivider(new Date())
        if (instanceId) {
          state.remoteTransport.send({
            type: 'engine_harness_message',
            tabId,
            instanceId,
            message: divider,
            source: 'clear',
          })
        } else {
          state.remoteTransport.send({
            type: 'message_added',
            tabId,
            message: {
              id: `clear-${Date.now()}`,
              role: 'system',
              content: divider,
              timestamp: Date.now(),
              source: 'desktop',
            },
          })
        }
      }
    }
    // Auto-reconcile on event drops so state self-heals
    if (event.type === 'engine_events_dropped') {
      engineBridge.sendReconcileState(key)
    }
  })
}
