import type { NormalizedEvent, EnrichedError } from '../shared/types'
import { log as _log, trace as _trace } from './logger'
import { handleProviderLoginEvent } from './event-wiring-provider-login'
import { state, sessionPlane, engineBridge, extensionCommandRegistry, forwardedEnginePermissionDenials, lastForwardedTabStatus, lastForwardedTabMeta } from './state'
import { broadcast } from './broadcast'
import { shouldStreamThinkingToRemote } from './settings-store'
import { formatClearDivider } from '../shared/clear-divider'
import { tabIdFromKey } from '../shared/session-key'
import { subscribeToResourceKinds, subscribeToGlobalResourceKinds, clearResourceSubscriptions, markReadPersisted, resubscribeSessionResourceKinds } from './event-wiring-resources'
import { handleInterceptEvent } from './event-wiring-intercept'
import { injectDiskResourcesIfEmpty } from './event-wiring-disk-seed'
import { notifyAtvPermissionResolved } from './atv-window-manager'
export { wireTabFocusHandler, wireMarkResourceReadHandler, wireDeleteResourceHandler } from './event-wiring-resources'
export { wireRemoteSessionPlaneForwarding } from './event-wiring-remote'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}
function trace(msg: string, fields?: Record<string, unknown>): void {
  _trace('main', msg, fields)
}

/** Emit a NormalizedEvent to the renderer via the single normalized stream. */
function broadcastNormalized(tabId: string, event: NormalizedEvent): void {
  broadcast('ion:normalized-event', tabId, event)
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

  // Cross-surface permission reconcile: the control plane emits this from
  // its respondToPermission choke point (any surface's answer). Routed to
  // the ATV window here rather than called from the control plane directly,
  // which would re-create the engine-control-plane → atv-window-manager →
  // state module cycle.
  sessionPlane.on('permission-resolved', (tabId: string, questionId: string) => {
    notifyAtvPermissionResolved(tabId, questionId)
  })

  // engine_intercept from CLI-tab sessions. EngineControlPlane bubbles
  // engine_intercept up via ctx.emit('engine_intercept', tabId, event)
  // rather than emitting it as a NormalizedEvent (it's not one). The
  // intercept handler does device-focus routing, optional abort/re-prompt,
  // and renderer broadcast.
  sessionPlane.on('engine_intercept', (tabId: string, event: any) => {
    handleInterceptEvent(tabId, event).catch((err: unknown) => {
      log('wire_intercept_handler_error', { tab_id: tabId, error: (err as Error).message })
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
    // Self-stop when idle: an empty buffer means streaming has ended, so the
    // 16ms (~62.5Hz) timer has no work. Clear it rather than letting it wake the
    // event loop forever; the next engine_text_delta re-arms via
    // ensureDeltaFlushTimer(). Without this the timer ran for the process
    // lifetime after the first stream, burning idle CPU on empty ticks.
    if (pendingTextDeltas.size === 0) {
      if (deltaFlushTimer) {
        clearInterval(deltaFlushTimer)
        deltaFlushTimer = null
      }
      return
    }
    for (const [deltaKey, text] of pendingTextDeltas) {
      // WI-001: no longer broadcast to renderer via IPC.ENGINE_EVENT — text
      // deltas reach the renderer through the normalized stream (text_chunk
      // NormalizedEvent emitted by the engine control plane). The batch buffer
      // is kept for iOS remote-transport forwarding only.
      if (state.remoteTransport) {
        // Wire-key (Key A) parsing for iOS forwarding — NOT renderer pane
        // addressing. The `|| null` is load-bearing: a plain conversation's
        // wire key is bare (→ instanceId null), an extension-hosted instance's
        // is compound (→ its instanceId). iOS depends on this null vs id
        // distinction, so do NOT convert this to parseSessionKey (which would
        // map bare → 'main' and change the forwarded wire shape).
        const dtabId = deltaKey.split(':')[0]
        const dinstanceId = deltaKey.split(':')[1] || null
        state.remoteTransport.send({ type: 'desktop_text_delta', tabId: dtabId, instanceId: dinstanceId, text })
      }
    }
    pendingTextDeltas.clear()
  }

  function ensureDeltaFlushTimer(): void {
    if (!deltaFlushTimer) {
      deltaFlushTimer = setInterval(flushTextDeltas, 16)
    }
  }

  // Flush any buffered text for `key` immediately and send it to the remote
  // transport. Called synchronously before forwarding engine_message_end and
  // engine_tool_start so the desktop_text_delta enters the FIFO transport
  // queue BEFORE the seal/boundary event. Both are CRITICAL_TYPES and FIFO,
  // so flushing first guarantees iOS applies text before it seals the row —
  // the root cause of the post-#256 "streaming stalls after first turn" bug.
  function flushKeyDeltas(key: string): void {
    const text = pendingTextDeltas.get(key)
    if (!text || !state.remoteTransport) return
    pendingTextDeltas.delete(key)
    const dtabId = key.split(':')[0]
    const dinstanceId = key.split(':')[1] || null
    state.remoteTransport.send({ type: 'desktop_text_delta', tabId: dtabId, instanceId: dinstanceId, text })
  }

  // Subscribe to global resources on every (re)connect. The engine_command_registry
  // event only fires once during initial session creation; reconnects to a running
  // engine see "already exists" and skip the registry emission. Without this,
  // resource subscriptions are never re-established after a desktop restart.
  const subscribeGlobalResources = () => {
    clearResourceSubscriptions()
    log('engineBridge: subscribing to global resources')
    subscribeToGlobalResourceKinds().catch((err) => {
      log('resource_subscribe_global: error on connect', { error: String(err) })
    })
    // Re-establish per-session subscriptions for sessions that were active
    // before the reconnect. engine_command_registry only fires on initial
    // session creation; reconnects skip it.
    resubscribeSessionResourceKinds().catch((err) => {
      log('resource_subscribe: resubscribe error on connect', { error: String(err) })
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
    // engine_provider_login: forward each stage to the renderer and refresh the
    // model cache on completion (see event-wiring-provider-login.ts).
    if (handleProviderLoginEvent(event)) return

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
        log('engine_command_registry: cleared', { key, had })
      } else {
        const names = new Set<string>(listings.map((l: { name: string }) => l.name))
        extensionCommandRegistry.set(key, names)
        log('engine_command_registry: cached', { key, count: names.size })
      }
      // Extensions are loaded — subscribe to resource kinds now. The
      // command_registry event fires after the extension process has
      // declared its resource kinds, so the broker is ready to serve
      // subscription requests. Idempotent: subscribeToResourceKinds
      // skips kinds already subscribed for this session key.
      subscribeToResourceKinds(key).catch((err) => {
        log('resource_subscribe: error', { key, error: String(err) })
      })
      // Also subscribe to global resource kinds (workspace-scoped).
      // Idempotent: subscribeToGlobalResourceKinds skips already-subscribed kinds.
      subscribeToGlobalResourceKinds().catch((err) => {
        log('resource_subscribe_global: error', { error: String(err) })
      })
    }

    // engine_intercept: route through the intercept handler which checks
    // device focus, per-device and desktop preferences, and performs
    // targeted iOS forwarding + optional abort/re-prompt. Skip the generic
    // broadcast and generic iOS send below — the handler does both.
    if (event.type === 'engine_intercept') {
      const tabId = tabIdFromKey(key)
      handleInterceptEvent(tabId, event).catch((err: unknown) => {
        log('engine_intercept: handler error', { key, error: (err as Error).message })
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

    // WI-001: The raw IPC.ENGINE_EVENT broadcast to the renderer is retired.
    // All per-tab conversation events flow through the normalized stream
    // (ion:normalized-event) via the engine control plane. Cross-cutting events
    // (resources, command lifecycle, notifications) are emitted below as
    // normalized events so the renderer has exactly one subscription. The iOS
    // remoteTransport forwarding path below is unaffected — it was always
    // independent of the IPC broadcast.

    // Cross-cutting events: emitted as normalized events keyed by the session
    // tabId (bare). The renderer's handleCrossNormalizedEvent handles these
    // without touching conversation state.
    if (event.type === 'engine_command_registry') {
      const listings = Array.isArray(event.commands) ? event.commands : []
      const tabIdForCR = tabIdFromKey(key)
      broadcastNormalized(tabIdForCR, { type: 'command_registry', commands: listings })
    } else if (event.type === 'engine_command_result') {
      const tabIdForCR = tabIdFromKey(key)
      broadcastNormalized(tabIdForCR, {
        type: 'command_result',
        command: event.command,
        commandError: event.commandError,
      })
    } else if (event.type === 'engine_resource_snapshot') {
      // Resource snapshot observability
      const items = event.resourceItems ?? []
      log('resource_snapshot', { key, kind: event.resourceKind, sub_id: event.resourceSubId, items: items.length })
      // Cold-start disk seed: inject persisted items when the engine delivers
      // an empty snapshot (e.g. extension died during HandleQuery).
      if (items.length === 0 && state.mainWindow) {
        injectDiskResourcesIfEmpty(event.resourceKind, event.resourceSubId, key)
      }
      const tabIdForRes = tabIdFromKey(key)
      broadcastNormalized(tabIdForRes, {
        type: 'resource_snapshot',
        resourceKind: event.resourceKind,
        resourceSubId: event.resourceSubId,
        resourceItems: items,
      })
    } else if (event.type === 'engine_resource_delta') {
      const d = event.resourceDelta
      log('resource_delta', { key, kind: event.resourceKind, op: d?.op, id: d?.item?.id?.slice(-8), conv_id: d?.item?.conversationId ?? 'global' })
      // Persist mark_read deltas to disk so the desktop's read state survives
      // restarts and stays consistent with cross-device reads from iOS.
      if (d?.op === 'mark_read' && d?.item?.id) {
        markReadPersisted(d.item.id)
      }
      const tabIdForDelta = tabIdFromKey(key)
      broadcastNormalized(tabIdForDelta, {
        type: 'resource_delta',
        resourceKind: event.resourceKind,
        resourceDelta: d,
      })
    } else if (event.type === 'engine_notification') {
      // Log-only in main process; forward to renderer via normalized stream
      // so the renderer can display a notification indicator.
      log('engine_notification', { title: event.notificationTitle, level: event.notificationLevel })
      const tabIdForNotif = tabIdFromKey(key)
      broadcastNormalized(tabIdForNotif, {
        type: 'engine_notification',
        notificationTitle: event.notificationTitle,
        notificationBody: event.notificationBody,
        notificationLevel: event.notificationLevel,
      })
    } else if (event.type === 'engine_dispatch_activity') {
      // Live dispatched-agent transcript delta. Bridge it to the renderer as a
      // normalized event so the agent popup folds it into the per-dispatch
      // transcript cache (keyed by dispatchAgentId/conversationId). This is a
      // cross-cutting event — it must NOT touch the main conversation message
      // stream (that surface is text_chunk / tool_call). iOS receives the same
      // delta independently via the generic engineToWireType forwarder below.
      const tabIdForAct = tabIdFromKey(key)
      log('dispatch_activity', { key, agent_id: event.dispatchAgentId, conv_id: event.dispatchConversationId, kind: event.dispatchActivityKind, seq: event.dispatchSeq, tool_id: event.toolId ?? '' })
      broadcastNormalized(tabIdForAct, {
        type: 'dispatch_activity',
        dispatchAgentId: event.dispatchAgentId,
        dispatchConversationId: event.dispatchConversationId,
        dispatchActivityKind: event.dispatchActivityKind,
        dispatchSeq: event.dispatchSeq,
        toolName: event.toolName,
        toolId: event.toolId,
        dispatchTextDelta: event.dispatchTextDelta,
        dispatchToolIsError: event.dispatchToolIsError,
        dispatchActivityTs: event.dispatchActivityTs,
      })
    }

    // engine_context_breakdown: per-category token breakdown built during
    // prompt assembly. Broadcast to the renderer as a normalized event so
    // store slices can cache the latest breakdown per instance, and forward
    // to iOS as desktop_context_breakdown for the Status Drawer.
    if (event.type === 'engine_context_breakdown' && event.contextBreakdown) {
      const tabIdForBD = tabIdFromKey(key)
      broadcastNormalized(tabIdForBD, {
        type: 'context_breakdown',
        categories: event.contextBreakdown.categories ?? [],
        contextWindow: event.contextBreakdown.contextWindow,
        totalTokens: event.contextBreakdown.totalTokens,
        apiReportedTotal: event.contextBreakdown.apiReportedTotal,
        unaccounted: event.contextBreakdown.unaccounted,
        cacheReadTokens: event.contextBreakdown.cacheReadTokens,
        cacheCreationTokens: event.contextBreakdown.cacheCreationTokens,
        model: event.contextBreakdown.model ?? '',
        aggregateCostUsd: event.contextBreakdown.aggregateCostUsd,
        modelBreakdown: event.contextBreakdown.modelBreakdown,
      })
      if (state.remoteTransport) {
        const tabIdBD = key.split(':')[0]
        const instanceIdBD = key.split(':')[1] || null
        state.remoteTransport.send({
          type: 'desktop_context_breakdown',
          tabId: tabIdBD,
          instanceId: instanceIdBD,
          contextBreakdown: event.contextBreakdown,
        })
        log('engine_context_breakdown: forwarded to ios', { key, categories: event.contextBreakdown.categories?.length ?? 0, total: event.contextBreakdown.totalTokens })
      }
    }

    // Trace agent_state so we can correlate engine→desktop→iOS flow when
    // diagnosing stuck-row, stale-snapshot, or missing-conversation reports.
    // Pairs with the engine's `agent_snapshot_emitted` utils.Log line.
    // Demoted to trace: fires on every heartbeat tick (13k+/h at INFO),
    // generating the dominant share of desktop log volume. Available at
    // trace level when transport diagnosis is needed.
    if (event.type === 'engine_agent_state') {
      const agents = Array.isArray(event.agents) ? event.agents : []
      _trace('main', 'agent_state', { key, count: agents.length })
      // Trace dispatch metadata for terminal agents so we can verify
      // conversationId survives the engine→desktop pipeline.
      for (const a of agents) {
        if ((a.status === 'done' || a.status === 'error') && a.metadata?.task) {
          const meta = a.metadata
          _trace('main', 'agent_state: dispatch_agent', { name: a.name, status: a.status, conv_id: meta.conversationId ?? 'MISSING' })
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
      // Map engine event type strings to desktop_ wire event types. Most
      // engine_* events strip the engine_ prefix and add desktop_ (e.g.
      // engine_status → desktop_status). Exceptions below preserve the
      // engine_ segment in the output name so iOS decoders stay unambiguous.
      const engineToWireType = (engineType: string): string => {
        switch (engineType) {
          case 'engine_error':    return 'desktop_engine_error'
          case 'engine_profiles': return 'desktop_engine_profiles'
          default:                return `desktop_${engineType.replace('engine_', '')}`
        }
      }
      // Low-bandwidth mode (issue #158): gate the per-token reasoning stream.
      // `engine_thinking_delta` becomes `desktop_thinking_delta` on the wire.
      // When `streamThinkingToRemote` is OFF for this desktop we DROP the
      // delta (do not forward) to save bandwidth — but we ALWAYS forward the
      // block_start / block_end boundaries below so the phone still renders
      // the "💭 Thought for Ns" summary and never looks stalled mid-turn.
      // Both branches log so the operational log explains exactly why a
      // given iOS device did or did not receive the reasoning stream.
      //
      // Spread order matters: `...event` carries the engine's own
      // `type: 'engine_thinking_*'`, so it MUST come before the `type:`
      // override or it clobbers the computed wire type and iOS (which decodes
      // `desktop_thinking_*`) never matches. The text-delta path above
      // constructs its envelope explicitly for the same reason.
      if (event.type === 'engine_thinking_delta') {
        if (!shouldStreamThinkingToRemote()) {
          trace('thinking_delta: dropped', { key, reason: 'streamThinkingToRemote=off' })
        } else {
          trace('thinking_delta: forwarding', { key })
          state.remoteTransport.send({ ...event, tabId, instanceId, type: engineToWireType(event.type) })
        }
      } else if (event.type === 'engine_thinking_block_start' || event.type === 'engine_thinking_block_end') {
        // Boundaries always forward (never gated) so the phone renders the
        // "💭 Thought for Ns" summary and never looks stalled mid-turn.
        state.remoteTransport.send({ ...event, tabId, instanceId, type: engineToWireType(event.type) })
      } else {
        // Flush any buffered text for this key before forwarding turn-boundary
        // events. engine_message_end seals the current assistant row on iOS and
        // engine_tool_start starts a new tool row — if a pending text batch were
        // flushed by the 16ms timer AFTER those events arrived, iOS would see the
        // seal/tool-start first and append a spurious extra assistant message for
        // the tail text. Flushing here puts desktop_text_delta in the FIFO queue
        // BEFORE the boundary event, guaranteeing correct ordering. Both are
        // CRITICAL_TYPES so neither can be dropped or reordered relative to each
        // other by backpressure. All other event types are unaffected: the key has
        // no pending text or the flush is a cheap no-op.
        if (event.type === 'engine_message_end' || event.type === 'engine_tool_start') {
          flushKeyDeltas(key)
        }
        // engine_stream_reset discards the failed attempt's partial output on
        // every client. Any batched-but-unsent text for this key belongs to
        // that discarded attempt — DROP it (do not flush) so the 16ms timer
        // can't deliver stale pre-reset text to iOS after the reset event.
        if (event.type === 'engine_stream_reset') {
          pendingTextDeltas.delete(key)
        }
        // Spread order matters (same hazard documented above for the thinking
        // path): `...event` carries the engine's own `type: 'engine_*'`, so it
        // MUST come BEFORE the computed wire type or it clobbers it back to the
        // raw `engine_*` name. iOS decoders key off `desktop_*` (see
        // NormalizedEvent.swift TypeKey), so a clobbered `engine_*` type fails
        // to decode and the event is silently dropped on the phone. tabId /
        // instanceId likewise come last so an engine-supplied tabId on the
        // payload can't override the wire-key-derived split.
        state.remoteTransport.send({ ...event, tabId, instanceId, type: engineToWireType(event.type) })
      }

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
          log('engine_status: forwarding denial to remote', { key, tool_name: denial.toolName, question_id: questionId })
          // Stamp the engine instance (sub-tab) onto the envelope so iOS
          // can scope the plan/question card to the owning
          // sub-conversation instead of rendering it on every sibling
          // sub-tab under the same parent tab. `instanceId` is non-null
          // here — the enclosing guard requires it.
          state.remoteTransport.send({
            type: 'desktop_permission_request',
            tabId,
            instanceId,
            questionId,
            toolName: denial.toolName,
            toolInput: denial.toolInput,
            options: [],
          }, true, { title: 'Ion needs your attention', body: pushBody })
        }
      }
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
      // Deduped via lastForwardedTabStatus to avoid flooding on
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
        if (derivedStatus && lastForwardedTabStatus.get(tabId) !== derivedStatus) {
          lastForwardedTabStatus.set(tabId, derivedStatus)
          log('engine_status: synthesizing tab_status for remote', { tab_id: tabId, instance: instanceId, derived_status: derivedStatus })
          state.remoteTransport.send({ type: 'desktop_tab_status', tabId, status: derivedStatus as any })
        }
      }

      // Push a lightweight desktop_tab_meta delta when cost or conversationInstances
      // change on an engine_status tick. This lets iOS tab-row metadata (cost, instance
      // count) update without waiting for the 5 s snapshot poll.
      //
      // We track the last-forwarded value per tabId so we don't flood on repeated
      // engine_status ticks with the same cost (common during idle polling).
      if (event.type === 'engine_status' && state.remoteTransport) {
        const costUsd = typeof event.fields?.runCostUsd === 'number' ? event.fields.runCostUsd : undefined
        if (costUsd !== undefined) {
          const prevCost = lastForwardedTabMeta.get(tabId)
          if (prevCost !== costUsd) {
            lastForwardedTabMeta.set(tabId, costUsd)
            log('engine_status: pushing desktop_tab_meta cost delta', { tab_id: tabId, cost_usd: costUsd })
            state.remoteTransport.send({ type: 'desktop_tab_meta', tabId, totalCostUsd: costUsd })
          }
        }
      }

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
        log('engine_command_result: clear, notifying conversationCleared', { tab_id: tabId })
        sessionPlane.notifyConversationCleared(tabId)

        const divider = formatClearDivider(new Date())
        if (instanceId) {
          state.remoteTransport.send({
            type: 'desktop_harness_message',
            tabId,
            instanceId,
            message: divider,
            source: 'clear',
          })
        } else {
          state.remoteTransport.send({
            type: 'desktop_message_added',
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
