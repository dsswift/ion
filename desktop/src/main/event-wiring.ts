import type { NormalizedEvent, EnrichedError } from "../shared/types";
import { log as _log, trace as _trace } from "./logger";
import {
  handleProviderLoginEvent,
  handleProvidersUpdatedEvent,
} from "./event-wiring-provider-login";
import {
  state,
  sessionPlane,
  engineBridge,
  extensionCommandRegistry,
  forwardedEnginePermissionDenials,
  lastForwardedTabMeta,
} from "./state";
import { broadcast } from "./broadcast";
import { shouldStreamThinkingToRemote } from "./settings-store";
import { formatClearDividerForOutcome } from "../shared/clear-divider";
import { tabIdFromKey } from "../shared/session-key";
import {
  subscribeToResourceKinds,
  subscribeToGlobalResourceKinds,
  clearResourceSubscriptions,
  resubscribeSessionResourceKinds,
  ensureSessionResourceSubscription,
  handleResourceEngineEvent,
} from "./event-wiring-resources";
import { handleInterceptEvent } from "./event-wiring-intercept";
import { handleNotificationOrDispatchEvent } from "./event-wiring-notification";
import { handleCommandEvent } from "./event-wiring-command";
import { resourceCatalog } from "./resource-catalog";
import {
  accumulateTextDelta,
  flushKeyDeltas,
  dropKeyDeltas,
} from "./event-wiring-text-delta-batcher";
import { projectEngineEventToWire } from "./event-wiring-wire-projection";
import { notifyStudioPermissionResolved } from "./studio-window-manager";
import {
  recordStatusFields,
  recordWorkingMessage,
  clearAllAgentState,
} from "./agent-state-mirror";
import { resetAgentStateSelfHeal } from "./remote/handlers/agent-state";
import { ingestAgentStateEvent } from "./event-wiring-agent-state";
import { forwardRemoteEngineStatus } from "./event-wiring-remote-status";
export {
  wireTabFocusHandler,
  wireMarkResourceReadHandler,
  wireDeleteResourceHandler,
  wireResourceGetHandler,
  handleResourceItemEvent,
} from "./event-wiring-resources";
export { wireRemoteSessionPlaneForwarding } from "./event-wiring-remote";

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("main", msg, fields);
}
function trace(msg: string, fields?: Record<string, unknown>): void {
  _trace("main", msg, fields);
}

/** Emit a NormalizedEvent to the renderer via the single normalized stream. */
function broadcastNormalized(tabId: string, event: NormalizedEvent): void {
  broadcast("ion:normalized-event", tabId, event);
}

export function wireSessionPlaneEvents(): void {
  sessionPlane.on("event", (tabId: string, event: NormalizedEvent) => {
    broadcast("ion:normalized-event", tabId, event);
  });

  sessionPlane.on(
    "tab-status-change",
    (tabId: string, newStatus: string, oldStatus: string) => {
      broadcast("ion:tab-status-change", tabId, newStatus, oldStatus);
    },
  );

  sessionPlane.on("error", (tabId: string, error: EnrichedError) => {
    broadcast("ion:enriched-error", tabId, error);
  });

  // Cross-surface permission reconcile: the control plane emits this from
  // its respondToPermission choke point (any surface's answer). Routed to
  // the Studio window here rather than called from the control plane directly,
  // which would re-create the engine-control-plane → studio-window-manager →
  // state module cycle.
  sessionPlane.on(
    "permission-resolved",
    (tabId: string, questionId: string) => {
      notifyStudioPermissionResolved(tabId, questionId);
    },
  );

  // engine_intercept from CLI-tab sessions. EngineControlPlane bubbles
  // engine_intercept up via ctx.emit('engine_intercept', tabId, event)
  // rather than emitting it as a NormalizedEvent (it's not one). The
  // intercept handler does device-focus routing, optional abort/re-prompt,
  // and renderer broadcast.
  sessionPlane.on("engine_intercept", (tabId: string, event: any) => {
    handleInterceptEvent(tabId, event).catch((err: unknown) => {
      log("wire_intercept_handler_error", {
        tab_id: tabId,
        error: (err as Error).message,
      });
    });
  });
}

export function wireEngineBridgeEvents(): void {
  // ---------------------------------------------------------------------------
  // Text-delta batching lives in event-wiring-text-delta-batcher.ts (module
  // scope), so the compaction-marker emitter in event-wiring-remote.ts shares
  // the SAME buffer and flush. accumulateTextDelta() buffers + arms the 16ms
  // timer; flushKeyDeltas() drains one key immediately ahead of a same-key
  // envelope (the FIFO ordering guarantee, RC-5); dropKeyDeltas() discards a
  // key's pending text on stream reset. See that module's header for the
  // ordering invariant these three enforce.
  // ---------------------------------------------------------------------------
  // Subscribe to global resources on every (re)connect. The engine_command_registry
  // event only fires once during initial session creation; reconnects to a running
  // engine see "already exists" and skip the registry emission. Without this,
  // resource subscriptions are never re-established after a desktop restart.
  const subscribeGlobalResources = () => {
    clearResourceSubscriptions();
    resourceCatalog.clear();
    log("engineBridge: subscribing to global resources");
    subscribeToGlobalResourceKinds().catch((err) => {
      log("resource_subscribe_global: error on connect", {
        error: String(err),
      });
    });
    // Re-establish per-session subscriptions for sessions that were active
    // before the reconnect. engine_command_registry only fires on initial
    // session creation; reconnects skip it.
    resubscribeSessionResourceKinds().catch((err) => {
      log("resource_subscribe: resubscribe error on connect", {
        error: String(err),
      });
    });
  };
  engineBridge.on("reconnected", subscribeGlobalResources);

  // Tell the renderers the engine is reachable again so panes whose history
  // load failed during the outage re-arm hydration (rehydrateFailedHistory).
  // Routed through broadcast() so the overlay and the Studio mirror both hear it
  // — each window re-hydrates its own store.
  engineBridge.on("reconnected", () => {
    log("engineBridge: broadcasting engine reconnect to renderers");
    broadcast("ion:engine-reconnected");
    // Every mirrored roster is void across a reconnect: engine_agent_state is
    // a complete snapshot, and after an engine RESTART the old session keys
    // never emit again, so an entry kept here is stale forever (a 30.7 MB
    // dead-session roster once looped through self-heal for 10+ hours on
    // exactly this). Live sessions re-emit on re-registration within seconds,
    // repopulating the mirror; an iOS resync inside that window honestly
    // answers "no agents" instead of serving the stale copy.
    clearAllAgentState();
    resetAgentStateSelfHeal();
    log("engineBridge: agent-state mirror cleared on reconnect");
  });

  // Track whether we've done the initial global resource subscription.
  // The first engine event signals the bridge is live. Fire once.
  let initialSubscribeDone = false;

  engineBridge.on("event", (key: string, event: any) => {
    if (!initialSubscribeDone) {
      initialSubscribeDone = true;
      subscribeGlobalResources();
    }
    // engine_provider_login: forward each stage to the renderer and refresh the
    // model cache on completion (see event-wiring-provider-login.ts).
    if (handleProviderLoginEvent(event)) return;

    // engine_providers_updated: advisory refresh nudge (login, logout,
    // refresh_models, startup probe). See event-wiring-provider-login.ts.
    if (handleProvidersUpdatedEvent(event)) return;

    // engine_command_registry: refresh the main-process routing-hint cache
    // BEFORE broadcasting so the unified prompt pipeline always observes the
    // newest snapshot if a slash command is dispatched in the same tick.
    // Snapshot semantics — see state.ts comment on extensionCommandRegistry.
    if (event.type === "engine_command_registry") {
      const listings = Array.isArray(event.commands) ? event.commands : [];
      if (listings.length === 0) {
        // Empty list is the authoritative "no extension commands" signal —
        // drop the entry entirely so a future re-populate sees a clean slot
        // and routing-hint MISSes correctly trigger the engine-resolved
        // backstop. Leaving an empty Set in the map would be observationally
        // identical but harder to reason about in logs.
        const had = extensionCommandRegistry.has(key);
        extensionCommandRegistry.delete(key);
        log("engine_command_registry: cleared", { key, had });
      } else {
        const names = new Set<string>(
          listings.map((l: { name: string }) => l.name),
        );
        extensionCommandRegistry.set(key, names);
        log("engine_command_registry: cached", { key, count: names.size });
      }
      // Extensions are loaded — subscribe to resource kinds now. The
      // command_registry event fires after the extension process has
      // declared its resource kinds, so the broker is ready to serve
      // subscription requests. Idempotent: subscribeToResourceKinds
      // skips kinds already subscribed for this session key.
      //
      // NOT the only trigger. This event only fires for a session that
      // actually loaded an extension, so a plain conversation never reached
      // it and never subscribed — which made every desktop-produced
      // session-scoped resource (a chart) publish into a broker with no
      // subscriber. `ensureSessionResourceSubscription` below covers the
      // general case; this call stays because it is the earliest point a
      // extension-hosted session is known to be ready.
      subscribeToResourceKinds(key).catch((err) => {
        log("resource_subscribe: error", { key, error: String(err) });
      });
      // Also subscribe to global resource kinds (workspace-scoped).
      // Idempotent: subscribeToGlobalResourceKinds skips already-subscribed kinds.
      subscribeToGlobalResourceKinds().catch((err) => {
        log("resource_subscribe_global: error", { error: String(err) });
      });
    }

    // engine_intercept: route through the intercept handler which checks
    // device focus, per-device and desktop preferences, and performs
    // targeted iOS forwarding + optional abort/re-prompt. Skip the generic
    // broadcast and generic iOS send below — the handler does both.
    if (event.type === "engine_intercept") {
      const tabId = tabIdFromKey(key);
      handleInterceptEvent(tabId, event).catch((err: unknown) => {
        log("engine_intercept: handler error", {
          key,
          error: (err as Error).message,
        });
      });
      return;
    }

    // engine_text_delta: accumulate into the batch buffer instead of
    // broadcasting immediately. The 16ms flush timer coalesces multiple
    // small deltas (50-200/sec) into ~60 larger chunks/sec, cutting IPC
    // serialization overhead by 3-4x. iOS forwarding is also deferred.
    if (event.type === "engine_text_delta") {
      accumulateTextDelta(key, event.text || "");
      return;
    }

    // WI-001: The raw IPC.ENGINE_EVENT broadcast to the renderer is retired.
    // All per-tab conversation events flow through the normalized stream
    // (ion:normalized-event) via the engine control plane. Cross-cutting events
    // (resources, command lifecycle, notifications) are emitted below as
    // normalized events so the renderer has exactly one subscription. The iOS
    // remoteTransport forwarding path below is unaffected — it was always
    // independent of the IPC broadcast.

    handleCommandEvent(key, event, broadcastNormalized);
    handleResourceEngineEvent(key, event, broadcastNormalized);
    handleNotificationOrDispatchEvent(key, event, broadcastNormalized);

    // engine_context_breakdown: per-category token breakdown built during
    // prompt assembly. Broadcast to the renderer as a normalized event so
    // store slices can cache the latest breakdown per instance, and forward
    // to iOS as desktop_context_breakdown for the Status Drawer.
    if (event.type === "engine_context_breakdown" && event.contextBreakdown) {
      const tabIdForBD = tabIdFromKey(key);
      broadcastNormalized(tabIdForBD, {
        type: "context_breakdown",
        categories: event.contextBreakdown.categories ?? [],
        contextWindow: event.contextBreakdown.contextWindow,
        totalTokens: event.contextBreakdown.totalTokens,
        apiReportedTotal: event.contextBreakdown.apiReportedTotal,
        unaccounted: event.contextBreakdown.unaccounted,
        cacheReadTokens: event.contextBreakdown.cacheReadTokens,
        cacheCreationTokens: event.contextBreakdown.cacheCreationTokens,
        model: event.contextBreakdown.model ?? "",
        // The engine's authoritative occupancy figure. Forwarded so the renderer
        // reads one number for "how full is the context" instead of choosing
        // between the itemized sum (over-reports) and the last turn's provider
        // total (under-reports mid-turn).
        occupancyTokens: event.contextBreakdown.occupancyTokens,
        aggregateCostUsd: event.contextBreakdown.aggregateCostUsd,
        modelBreakdown: event.contextBreakdown.modelBreakdown,
      });
      // Mirror the other two live-state fields from the same upstream point, so
      // an iOS resync is answered entirely from main. Both are recorded before
      // the renderer forward below, so the mirror is never the staler copy.
      if (event.type === "engine_status" && event.fields) {
        const [k0, k1] = key.split(":");
        recordStatusFields(k0, k1 || null, event.fields);
      }
      // Every live session subscribes to its own resource broker, whether or
      // not it hosts an extension. `engine_status` is the seam because it fires
      // for every session; `engine_command_registry` does not, and relying on
      // it alone left plain conversations with no subscription at all.
      ensureSessionResourceSubscription(key);
      if (event.type === "engine_working_message") {
        const [k0, k1] = key.split(":");
        // '' is meaningful: it is how a stale banner is cleared.
        recordWorkingMessage(
          k0,
          k1 || null,
          typeof event.message === "string" ? event.message : "",
        );
      }

      if (state.remoteTransport) {
        const tabIdBD = key.split(":")[0];
        const instanceIdBD = key.split(":")[1] || null;
        state.remoteTransport.send({
          type: "desktop_context_breakdown",
          tabId: tabIdBD,
          instanceId: instanceIdBD,
          contextBreakdown: event.contextBreakdown,
        });
        log("engine_context_breakdown: forwarded to ios", {
          key,
          categories: event.contextBreakdown.categories?.length ?? 0,
          total: event.contextBreakdown.totalTokens,
        });
      }
    }

    // Trace agent_state so we can correlate engine→desktop→iOS flow when
    // diagnosing stuck-row, stale-snapshot, or missing-conversation reports.
    // Pairs with the engine's `agent_snapshot_emitted` utils.Log line.
    // Demoted to trace: fires on every heartbeat tick (13k+/h at INFO),
    // generating the dominant share of desktop log volume. Available at
    // trace level when transport diagnosis is needed.
    if (event.type === "engine_agent_state") {
      // Ingest bound + upstream mirror record + tracing. Mutates the event
      // when the roster exceeds the ingest cap so every downstream copy
      // (renderer store, iOS wire) carries the bounded form. Details in
      // event-wiring-agent-state.ts.
      ingestAgentStateEvent(key, event as never);
    }

    if (state.remoteTransport) {
      // Wire-key (Key A) parsing for iOS forwarding — NOT renderer pane
      // addressing. `|| null` is load-bearing: bare wire key (plain
      // conversation) → null; compound (extension-hosted instance) → its
      // instanceId. iOS depends on this distinction; do NOT convert to
      // parseSessionKey (it would map bare → 'main').
      const tabId = key.split(":")[0];
      const instanceId = key.split(":")[1] || null;
      // Every engine event the desktop sees gets forwarded to iOS, with
      // no per-event filtering. The previous special case that skipped
      // engine_early_stop_decision_request was removed once iOS gained
      // a decoder for it (see ios/IonRemote/Models/NormalizedEvent.swift
      // and the contract test in ContractSyncTests.swift). iOS observes
      // the event for diagnostic visibility only — the desktop is the
      // authoritative responder via early-stop-policy.ts — but the wire
      // protocol is now uniform across consumers.
      //
      // The engine→wire type mapping and the per-type envelope projection
      // (including the explicit field mappings for engine_tool_stalled and
      // engine_image_content, whose raw engine field names differ from the
      // wire contract) live in event-wiring-wire-projection.ts.
      // Low-bandwidth mode (issue #158): gate the per-token reasoning stream.
      // `engine_thinking_delta` becomes `desktop_thinking_delta` on the wire.
      // When `streamThinkingToRemote` is OFF for this desktop we DROP the
      // delta (do not forward) to save bandwidth — but we ALWAYS forward the
      // block_start / block_end boundaries below so the phone still renders
      // the "💭 Thought for Ns" summary and never looks stalled mid-turn.
      // Both branches log so the operational log explains exactly why a
      // given iOS device did or did not receive the reasoning stream.
      if (event.type === "engine_thinking_delta") {
        if (!shouldStreamThinkingToRemote()) {
          trace("thinking_delta: dropped", {
            key,
            reason: "streamThinkingToRemote=off",
          });
        } else {
          trace("thinking_delta: forwarding", { key });
          state.remoteTransport.send(
            projectEngineEventToWire(event, tabId, instanceId) as any,
          );
        }
      } else if (
        event.type === "engine_thinking_block_start" ||
        event.type === "engine_thinking_block_end"
      ) {
        // Boundaries always forward (never gated) so the phone renders the
        // "💭 Thought for Ns" summary and never looks stalled mid-turn.
        state.remoteTransport.send(
          projectEngineEventToWire(event, tabId, instanceId) as any,
        );
      } else if (event.type === "engine_notification") {
        // Forwarded to iOS with push=false when connected; the push=true path
        // is handled in the early-exit branch above (avoids a duplicate frame).
        if (!event.push) {
          state.remoteTransport.send(
            projectEngineEventToWire(event, tabId, instanceId) as any,
          );
        }
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
        if (
          event.type === "engine_message_end" ||
          event.type === "engine_tool_start"
        ) {
          flushKeyDeltas(key);
        }
        // engine_stream_reset discards the failed attempt's partial output on
        // every client. Any batched-but-unsent text for this key belongs to
        // that discarded attempt — DROP it (do not flush) so the 16ms timer
        // can't deliver stale pre-reset text to iOS after the reset event.
        if (event.type === "engine_stream_reset") {
          dropKeyDeltas(key);
        }
        // Envelope construction (generic spread + the explicit projections for
        // engine_tool_stalled / engine_image_content, whose engine field names
        // differ from the wire contract) is centralized in
        // event-wiring-wire-projection.ts.
        state.remoteTransport.send(
          projectEngineEventToWire(event, tabId, instanceId) as any,
        );
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
      if (
        event.type === "engine_status" &&
        Array.isArray(event.fields?.permissionDenials) &&
        event.fields.permissionDenials.length > 0 &&
        instanceId
      ) {
        for (const denial of event.fields.permissionDenials) {
          if (
            denial.toolName !== "AskUserQuestion" &&
            denial.toolName !== "ExitPlanMode"
          )
            continue;
          const questionId = `denied-${denial.toolUseId}`;
          if (forwardedEnginePermissionDenials.has(questionId)) {
            // Already pushed for this toolUseId — skip silently. We hit
            // this path on every cost-only engine_status tick after the
            // initial denial-carrying tick.
            continue;
          }
          forwardedEnginePermissionDenials.add(questionId);
          // Cap the dedup set to prevent unbounded growth. The set stores
          // one entry per permission denial ever forwarded; power users
          // can generate thousands over a long session. When the cap is
          // hit, clear the entire set — false-positive re-forwards are
          // harmless (just a duplicate push notification).
          if (forwardedEnginePermissionDenials.size > 1000) {
            forwardedEnginePermissionDenials.clear();
            forwardedEnginePermissionDenials.add(questionId);
          }
          const pushBody =
            denial.toolName === "AskUserQuestion"
              ? "Question waiting for your answer"
              : "Plan ready for your review";
          log("engine_status: forwarding denial to remote", {
            key,
            tool_name: denial.toolName,
            question_id: questionId,
          });
          // Stamp the engine instance (sub-tab) onto the envelope so iOS
          // can scope the plan/question card to the owning
          // sub-conversation instead of rendering it on every sibling
          // sub-tab under the same parent tab. `instanceId` is non-null
          // here — the enclosing guard requires it.
          state.remoteTransport.send(
            {
              type: "desktop_permission_request",
              tabId,
              instanceId,
              questionId,
              toolName: denial.toolName,
              toolInput: denial.toolInput,
              options: [],
            },
            true,
            { title: "Ion needs your attention", body: pushBody, tabId },
          );
        }
      }
      if (event.type === "engine_status") {
        forwardRemoteEngineStatus(tabId, instanceId, event.fields);
      }

      // Push a lightweight desktop_tab_meta delta when cost or conversationInstances
      // change on an engine_status tick. This lets iOS tab-row metadata (cost, instance
      // count) update without waiting for the 5 s snapshot poll.
      //
      // We track the last-forwarded value per tabId so we don't flood on repeated
      // engine_status ticks with the same cost (common during idle polling).
      if (event.type === "engine_status" && state.remoteTransport) {
        const costUsd =
          typeof event.fields?.runCostUsd === "number"
            ? event.fields.runCostUsd
            : undefined;
        if (costUsd !== undefined) {
          const prevCost = lastForwardedTabMeta.get(tabId);
          if (prevCost !== costUsd) {
            lastForwardedTabMeta.set(tabId, costUsd);
            log("engine_status: pushing desktop_tab_meta cost delta", {
              tab_id: tabId,
              cost_usd: costUsd,
            });
            state.remoteTransport.send({
              type: "desktop_tab_meta",
              tabId,
              totalCostUsd: costUsd,
            });
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
      if (
        event.type === "engine_command_result" &&
        event.command === "clear" &&
        !event.commandError
      ) {
        // The engine successfully cleared the conversation. Advance the
        // desktop's freshness checkpoint so the next slash command on this
        // tab is treated as the first prompt of a blank conversation by
        // the slash-command lifecycle. The engine
        // intentionally keeps `s.conversationID` set (/clear is a
        // checkpoint, not a session restart) — without this notification
        // the post-/clear slash would see `promptCountSinceCheckpoint > 0`
        // and incorrectly preserve plan mode.
        log("engine_command_result: clear, notifying conversationCleared", {
          tab_id: tabId,
        });
        sessionPlane.notifyConversationCleared(tabId);

        // Flush any pending batched text for this key BEFORE emitting the clear
        // divider. The divider is a same-tab envelope; if the 16ms delta timer
        // flushed the tail text AFTER the divider frame, the divider would carry
        // a lower seq and iOS (pure insertion order) would render it ABOVE text
        // that chronologically preceded it. This is the same FIFO discipline the
        // engine_message_end / engine_tool_start path uses above — every same-key
        // immediate send must drain pending text first. See RC-5.
        flushKeyDeltas(key);

        const divider = formatClearDividerForOutcome(new Date(), event.clearKeepPlan, event.clearKeptPlanSlug);
        if (instanceId) {
          state.remoteTransport.send({
            type: "desktop_harness_message",
            tabId,
            instanceId,
            message: divider,
            source: "clear",
          });
        } else {
          state.remoteTransport.send({
            type: "desktop_message_added",
            tabId,
            message: {
              id: `clear-${Date.now()}`,
              role: "system",
              content: divider,
              timestamp: Date.now(),
              source: "desktop",
            },
          });
        }
      }
    }
    // Auto-reconcile on event drops so state self-heals
    if (event.type === "engine_events_dropped") {
      engineBridge.sendReconcileState(key);
    }
  });
}
