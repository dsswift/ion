// EngineEvent — the engine's outbound wire event union (engine_* types).
//
// Extracted from types-engine.ts to keep that file under the 600-line cap.
// Re-exported from types-engine.ts so existing
// `import type { EngineEvent } from './types-engine'` sites keep working.
//
// The union references shared engine types (AgentStateUpdate, StatusFields,
// SessionStatus), imported below from their defining module. The
// async-trigger, resource, and client-observation variants live in
// types-engine-event-async.ts (EngineEventAsync) to keep this file under the
// 600-line cap; EngineEvent includes that union unchanged via `| EngineEventAsync`.
import type {
  AgentStateUpdate,
  BackgroundTaskState,
  PollState,
  StatusFields,
  SessionStatus,
} from "./types-engine";
import type { ClientToolCallState } from "./types-tool-gate";
import type { EngineEventAsync } from "./types-engine-event-async";
/**
 * One stage transition of a delegated-CLI login (codex/grok/cursor). Payload of
 * the engine_provider_login event; mirrors Go ProviderLoginUpdate.
 */
export interface ProviderLoginUpdate {
  provider: string;
  backend: string;
  /** started | await_browser | await_device_code | await_auth_code | completed | failed | cancelled */
  stage: string;
  authUrl?: string;
  userCode?: string;
  verificationUrl?: string;
  loginError?: string;
  loginId?: string;
}

/**
 * One configured MCP server and what the engine currently knows about it.
 * Carried by the engine_mcp_servers event; mirrors Go McpServerStatus.
 *
 * `connected` and `authenticated` are independent. A server can be connected
 * without authentication (it requires none), or authenticated but not connected
 * (a token is stored and the last connect attempt still failed). Rendering them
 * as one combined "ok" state would hide the case an operator must act on: a
 * stored token that is not getting them in. `lastError` carries the most recent
 * connection failure, which is how a client with no access to the engine host's
 * log file can explain why a configured server is absent.
 */
export interface McpServerStatus {
  name: string;
  /** http | sse | ws | stdio */
  transport?: string;
  url?: string;
  command?: string;
  connected: boolean;
  authenticated: boolean;
  toolCount?: number;
  protocolVersion?: string;
  capabilities?: string[];
  lastError?: string;
}

export type EngineEvent =
  | { type: "engine_agent_state"; agents: AgentStateUpdate[] }
  | {
      type: "engine_status";
      fields: StatusFields;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "engine_session_status";
      sessionStatus: SessionStatus;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "engine_working_message";
      message: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "engine_notify";
      message: string;
      level: "info" | "warning" | "error";
      metadata?: Record<string, unknown>;
    }
  | {
      type: "engine_dialog";
      dialogId: string;
      method: "select" | "confirm" | "input";
      title: string;
      message?: string;
      options?: string[];
      defaultValue?: string;
    }
  // engine_elicitation_request — an extension called ctx.elicit(). The engine
  // fans this to every connected client expecting one to respond with an
  // `elicitation_response` command (or a peer extension's elicitation_request
  // hook to answer). `mode` selects the renderer ("approval", "select", ...);
  // `schema` describes what is being requested. Mirrors the Go fields
  // ElicitRequestID/ElicitSchema/ElicitURL/ElicitMode in engine_event.go.
  | {
      type: "engine_elicitation_request";
      requestId: string;
      schema?: Record<string, unknown>;
      url?: string;
      elicitMode?: string;
      elicitSource?: string;
      elicitServer?: string;
      elicitMessage?: string;
      elicitAction?: string;
    }
  // `metadata` is an opaque pass-through map the harness sets via ctx.emit
  // that the engine forwards verbatim. The desktop renderer honors
  // `metadata.dedupKey` (string) to suppress repeated harness messages
  // within an engine-instance scrollback — see engine-event-slice.ts. The
  // convention is renderer-honored, not engine-enforced; other extensions
  // may pick their own keys (namespace as `<extensionName>:<messageKey>`).
  | {
      type: "engine_harness_message";
      message: string;
      source?: string;
      metadata?: Record<string, unknown>;
    }
  | { type: "engine_text_delta"; text: string }
  | {
      type: "engine_message_end";
      usage: {
        inputTokens: number;
        outputTokens: number;
        contextPercent: number;
        cost: number;
        entryId?: string;
        userEntryId?: string;
      };
    }
  // engine_user_turn_persisted — the canonical persisted tree-entry id of the
  // run-opening user turn, announced immediately after the engine persists it
  // (before streaming). Re-key signal only, never content: consumers re-key
  // their optimistic user row to this id so history loads dedup against it
  // even when the run never reaches a message_end (cancel, mid-stream
  // failure). Mirror of Go EngineEvent.UserTurnEntryID.
  | {
      type: "engine_user_turn_persisted";
      userTurnEntryId: string;
      userTurnSlashModelAlias?: string;
      userTurnSlashModelEffective?: string;
      userTurnSlashFrontmatter?: Record<string, unknown>;
    }
  | { type: "engine_tool_start"; toolName: string; toolId: string }
  | {
      type: "engine_tool_end";
      toolId: string;
      result?: string;
      isError?: boolean;
    }
  // engine_image_content — a single image produced during a run, either
  // tool-returned (imageSource 'tool', imageToolId set to the producing tool
  // call) or provider-generated (imageSource 'provider', imageToolId empty).
  // imagePath is the on-disk FILE PATH under the conversation's images/
  // directory; the engine never puts base64 on the wire. The main-process
  // control plane translates this to the `image_content` NormalizedEvent the
  // renderer's event-slice-images materializer consumes. Mirror of the Go
  // EngineEvent Image* fields (engine/internal/types/engine_event.go).
  | {
      type: "engine_image_content";
      imagePath: string;
      imageMediaType: string;
      imageSource: string;
      imageToolId?: string;
      imageContentHash?: string;
    }
  | { type: "engine_tool_update"; toolId: string; partialInput: string }
  | { type: "engine_tool_complete"; index?: number }
  | {
      type: "engine_dead";
      exitCode: number | null;
      signal: string | null;
      stderrTail: string[];
    }
  | {
      type: "engine_error";
      message: string;
      errorCode?: string;
      errorCategory?: string;
      retryable?: boolean;
      retryAfterMs?: number;
      httpStatus?: number;
      stderrTail?: string[];
    }
  | {
      type: "engine_permission_request";
      questionId: string;
      permToolName: string;
      permToolDescription?: string;
      permToolInput?: Record<string, unknown>;
      permOptions: Array<{ id: string; label: string; kind?: string }>;
    }
  | {
      type: "engine_background_work_delivered";
      backgroundWorkDelivered?: {
        entryId: string;
        content: string;
        work: {
          kind: string;
          deliveryMode: string;
          items: Array<{
            id: string;
            source: string;
            label?: string;
            status: string;
            exitCode: number;
            elapsedMs?: number;
            outputPath?: string;
          }>;
          remainingTaskIds?: string[];
        };
      };
    }
  // engine_tool_gate_request (EngineConfig.toolGate).
  // Answered programmatically with a tool_gate_response command, never surfaced
  // in human permission UI. gateKind 'policy' (or absent) asks allow/deny for a
  // gated engine tool call; gateKind 'tool' asks the client to EXECUTE one of
  // its declared clientTools and answer with gateContent/gateIsError.
  // gateSiblingTools names the other tool calls in the same model turn so a
  // policy can evaluate turn isolation. gateHumanWait was the blocking
  // human-wait routing flag; the engine no longer emits it (human-wait tools
  // park the run instead) but the field survives so an older engine's events
  // still decode.
  // humanWait flag onto a gateKind 'tool' request: true routes to interactive
  // UI (the wait is human-paced and may stay open indefinitely); false/absent
  // is a machine fulfillment answered programmatically under the finite
  // client-tool timeout.
  | {
      type: "engine_tool_gate_request";
      gateRequestId: string;
      gateKind?: "policy" | "tool";
      gateToolName: string;
      gateToolInput?: Record<string, unknown>;
      gateCwd?: string;
      gateSiblingTools?: string[];
      gateHumanWait?: boolean;
      // Who asked: 'model' for the normal tool loop, 'extension' for a
      // ctx.callTool() from trusted harness code. Absent means 'model' (an
      // older engine did not send it). A client policy that must trust
      // extension code more than an LLM reads this — Studio's browser
      // session-mode rule is the first such consumer.
      gateOrigin?: "model" | "extension";
    }
  // engine_client_tool_state — a COMPLETE REPLACEMENT snapshot of every
  // client-tool call the engine is currently blocked on for this session.
  // Same semantics as engine_agent_state: replace local state with the
  // payload; an empty array is the authoritative "nothing pending" clear.
  // Emitted on every membership change and replayed by reconcile_state, so
  // a reconnecting client re-renders pending human-wait cards (the
  // requestIds stay answerable — the reply channels are engine-side) or
  // clears stale ones.
  | {
      type: "engine_client_tool_state";
      clientToolCalls: ClientToolCallState[];
    }
  | {
      type: "engine_plan_mode_changed";
      planModeEnabled: boolean;
      planFilePath?: string;
      planSlug?: string;
    }
  // engine_oidc_login_url — delivered to the client that issued
  // oidc_begin_login. Interactive PKCE carries oidcAuthorizationUrl (open
  // it in a browser; the engine's loopback callback completes the
  // exchange); device-code carries oidcUserCode + oidcVerificationUri
  // (display them; the engine polls to completion).
  | {
      type: "engine_oidc_login_url";
      oidcAuthorizationUrl?: string;
      oidcUserCode?: string;
      oidcVerificationUri?: string;
    }
  // engine_provider_login — one stage transition of a delegated-CLI login
  // (codex/grok/cursor). Incremental: consumers render the current stage; a
  // terminal completed/failed/cancelled stage ends the flow.
  | { type: "engine_provider_login"; providerLogin?: ProviderLoginUpdate }
  // engine_oidc_identity — complete SNAPSHOT of the operator's OIDC
  // identity state, broadcast on every login/logout transition and
  // answered to oidc_identity queries. Consumers REPLACE their local
  // identity view with the payload; claim fields are absent when signed
  // out.
  | {
      type: "engine_oidc_identity";
      oidcSignedIn: boolean;
      oidcRequired: boolean;
      oidcProvider?: string;
      oidcSubject?: string;
      oidcUsername?: string;
      oidcDisplayName?: string;
    }
  // engine_mcp_login_url — delivered to the client that issued mcp_login.
  // mcpAuthorizationUrl is opened in a browser; the engine's loopback callback
  // completes the code exchange and persists the token. mcpServerName says
  // which server it authorizes, since more than one login can be in flight.
  | {
      type: "engine_mcp_login_url";
      mcpServerName?: string;
      mcpAuthorizationUrl?: string;
    }
  // engine_mcp_servers — complete SNAPSHOT of the configured MCP servers with
  // their connection and authorization state. Broadcast on every transition
  // (add, remove, login, logout) and answered to mcp_list queries. Consumers
  // REPLACE their local server view with the payload; never merge. An absent or
  // empty array is the authoritative "no MCP servers configured" signal.
  | { type: "engine_mcp_servers"; mcpServers?: McpServerStatus[] }
  // engine_plan_file_written fires when a Write/Edit lands on the canonical
  // plan file during plan mode — the accurate trigger for the "plan created /
  // updated" conversation marker (the file now exists with content, so the
  // marker is correctly positioned and any link resolves). `planWriteOperation`
  // discriminates "created" (first content) from "updated" (a revision).
  | {
      type: "engine_plan_file_written";
      planWriteOperation: "created" | "updated" | string;
      planFilePath?: string;
      planSlug?: string;
    }
  // engine_plan_proposal is the workflow-level counterpart to
  // engine_plan_mode_changed: it fires when the model *proposes* a plan-mode
  // transition (e.g. by calling ExitPlanMode) but the actual mode change is
  // deferred to the consumer's user-approval chokepoint. The `kind` field
  // discriminates the proposal — `"exit"` is the only kind emitted today;
  // future kinds may include `"enter"` or `"amend"`. Consumers must treat
  // unknown kinds as forward-compatible. See
  // docs/architecture/adr/003-state-events-vs-workflow-events.md for the
  // state-vs-workflow distinction. PlanFilePath and PlanSlug are carried
  // directly so consumers don't have to scrape `permissionDenials.toolInput`
  // to recover them.
  | {
      type: "engine_plan_proposal";
      planProposalKind: "exit" | string;
      planFilePath?: string;
      planSlug?: string;
    }
  // engine_plan_mode_auto_exit fires when the engine deterministically
  // synthesizes an ExitPlanMode call at end-of-turn because the model
  // ended a plan-mode run without invoking ExitPlanMode or
  // AskUserQuestion (issue #187). It is a sibling to
  // engine_plan_proposal: both surface the plan-approval card, but
  // this event additionally tells consumers the exit was
  // engine-driven rather than model-driven.
  //
  // Emitted BEFORE the companion engine_plan_proposal{kind:"exit"} so
  // consumers that key off the synthesis specifically see it first.
  // The TaskCompleteEvent that follows carries the same synthesized
  // PermissionDenial as the model-driven path, so consumers keying
  // off the denial path continue to render approval cards unchanged.
  //
  // Use cases: telemetry on prompt quality (how often does the model
  // misroute plan exit?); subtle UI hints that the synthesis fired
  // ("Plan surfaced automatically — review carefully").
  | {
      type: "engine_plan_mode_auto_exit";
      stopReason: string;
      planFilePath?: string;
      planSlug?: string;
      reason?: string;
      sessionId?: string;
      runId?: string;
    }
  | { type: "engine_stream_reset" }
  | {
      type: "engine_compacting";
      active: boolean;
      summary?: string;
      messagesBefore?: number;
      messagesAfter?: number;
      clearedBlocks?: number;
      strategy?: string;
      microOnly?: boolean;
    }
  | {
      type: "engine_tool_stalled";
      toolId: string;
      toolName: string;
      toolElapsed: number;
    }
  // Mid-turn steer-drain confirmation. Engine emits this after the
  // runloop drainSteer helper captures a steer message (queued via the
  // steer channel) and injects it into the conversation as a user turn
  // before the next LLM call. `steerMessageLength` is the character
  // count; the body is not echoed back over the wire because it is
  // already part of the conversation. `steerClientMessageId` echoes the
  // client's steer_agent correlation id when supplied and this was a
  // genuine client-originated steer (never present for a machine-to-machine
  // injection). `steerEntryId` is the durable conversation-tree entry id
  // the steer text was persisted under, present only for a genuine
  // client-originated steer -- the exact target for a later
  // engine_rewind command. See
  // engine/internal/types/normalized_event.go (SteerInjectedEvent).
  | {
      type: "engine_steer_injected";
      steerMessageLength: number;
      steerClientMessageId?: string;
      steerEntryId?: string;
      steerKind?: string;
      steerMachineAuthored?: boolean;
    }
  // No owning run was live, so ctx.steerSelf delivered a fresh prompt instead.
  | {
      type: "engine_steer_degraded";
      steerDegradedMessageLength: number;
      steerKind?: string;
      steerMachineAuthored?: boolean;
    }
  | {
      type: "engine_agent_state_clamped";
      clampedAgentName?: string;
      clampedScope?: string;
      clampedKeys?: string[];
      clampedDroppedKeys?: string[];
      clampedOriginalBytes?: number;
      clampedBytes?: number;
      clampedLimitBytes?: number;
    }
  | {
      type: "engine_prompt_injected";
      injectedPrompt: string;
      injectedPromptOrigin?: string;
      injectedPromptKind?: string;
      injectedPromptMachineAuthored?: boolean;
    }
  // engine_run_stalled — advisory event emitted by the run-progress watchdog
  // when a run records no forward progress for longer than the configured
  // RunStall threshold. The authoritative completion signal is the follow-up
  // task_complete; this event is for observability only.
  | {
      type: "engine_run_stalled";
      runStalledDuration: number;
      runStalledLastActivity?: string;
    }
  | {
      type: "engine_run_recovery";
      runRecoveryId: string;
      runRecoveryPhase:
        "started" | "completed" | "skipped" | "exhausted" | "failed" | string;
      runRecoveryAttempt?: number;
      runRecoveryMaxAttempts?: number;
      runRecoveryReason?: string;
    }
  // engine_task_suspended — a run ended without completing, because it is parked.
  // Two producers. A dispatched agent that called ctx.suspend() /
  // ctx.suspendUntilAll() is waiting on child completions or a revive message;
  // taskSuspendAwaitingCount is the number of pending children (0 for bare
  // suspend). A session parked at a turn boundary is waiting on outstanding
  // background bash commands; taskSuspendAwaitingTaskCount is how many. Clients
  // may show a parked/idle indicator. Task completion fires later on revival.
  | {
      type: "engine_task_suspended";
      taskSuspendAwaitingCount?: number;
      taskSuspendAwaitingTaskCount?: number;
    }
  | {
      type: "engine_background_task_started";
      backgroundTaskStarted?: BackgroundTaskState;
    }
  | {
      type: "engine_background_task_terminal";
      backgroundTaskTerminal?: {
        taskId: string;
        status: string;
        exitCode?: number;
        elapsedMs?: number;
        command?: string;
        outputPath?: string;
        tail?: string;
      };
    }
  | {
      type: "engine_poll_started";
      pollStarted?: PollState;
    }
  | {
      type: "engine_poll_progress";
      pollProgress?: { poll: PollState; evidence: string };
    }
  | {
      type: "engine_poll_terminal";
      pollTerminal?: PollState & { verdict: "satisfied" | "failed" | "stuck" | "exhausted" | string; evidence: string; reason?: string };
    }
  | {
      type: "engine_session_work_stopped";
      sessionWorkStopped?: {
        scope: string;
        cancelledRunId?: string;
        recalledDispatchIds?: string[];
        stoppedBackgroundTaskIds?: string[];
        killedAgentProcessCount?: number;
      };
    }
  // engine_background_task_complete — a background bash command started with
  // Bash({ run_in_background: true, notify_on_complete: true }) reached a
  // terminal state. Emitted for every notifying command regardless of whether
  // the engine also delivers the result into a run, so a consumer can render
  // completions without scraping run content. remainingTaskIds carries the
  // session's still-outstanding commands at that instant.
  | {
      type: "engine_background_task_complete";
      backgroundTaskComplete?: {
        taskId: string;
        status: string;
        exitCode: number;
        elapsedMs: number;
        outputPath?: string;
        tail?: string;
        command?: string;
        remainingTaskIds?: string[];
      };
    }
  // engine_dispatch_lost — a dispatch that was running when the engine
  // process died is unrecoverable after restart. One event per orphan,
  // emitted on the owning session's stream during dispatch-state
  // rehydration; the rehydrated agent-state row is independently marked
  // "error" so no panel shows a dead dispatch as running. Consumers may
  // redispatch, harvest the child's partial transcript via
  // childConversationId, or ignore the event.
  | {
      type: "engine_dispatch_lost";
      dispatchLost?: {
        dispatchId: string;
        agentName: string;
        task?: string;
        parentDispatchId?: string;
        depth?: number;
        childConversationId?: string;
      };
    }
  // engine_model_fallback — workflow signal emitted by the engine when
  // it fell back to its configured defaultModel because the requested
  // model didn't resolve to a provider. Mirrors the underlying
  // ModelFallbackEvent NormalizedEvent variant. The desktop renders a
  // small ⚠ glyph on the affected engine instance pill via the
  // engineModelFallbacks store map; iOS receives the fact through the
  // snapshot path (RemoteTabState.conversationInstances[i].modelFallback)
  // rather than as a live RemoteEvent. See CLAUDE.md §
  // "The typed-event corollary" for the broader rule.
  | {
      type: "engine_model_fallback";
      fallbackRequestedModel: string;
      fallbackModel: string;
      fallbackReason: string;
    }
  // engine_model_tiers is a complete snapshot. Consumers replace, never merge.
  | {
      type: "engine_model_tiers";
      modelTiers: import("./types-model-tiers").ModelTier[];
    }
  // engine_capability_unsupported — workflow signal emitted when a requested
  // feature (e.g. plan mode) is not supported by the backend that would serve
  // the run; the engine declined the prompt cleanly instead of dispatching a
  // run that would fail. No run starts and the session stays idle, so clients
  // render a recoverable message (not a dead engine). Mirrors the underlying
  // CapabilityUnsupportedEvent NormalizedEvent variant. See CLAUDE.md §
  // "The typed-event corollary".
  | {
      type: "engine_capability_unsupported";
      capability: string;
      capabilityBackend: string;
      capabilityReason: string;
    }
  // Extended-thinking events (issue #158). Surface the model's reasoning
  // activity so consumers can distinguish active reasoning from a stall and
  // render a "thinking" view. Emitted only when the provider streams reasoning
  // (Anthropic extended thinking); a thinking block is OPTIONAL per turn.
  // Boundaries (start/end) always emit; engine_thinking_delta is gated by the
  // engine's ThinkingConfig.StreamDeltas (default on). See
  // engine/internal/types/normalized_event.go (Thinking*Event).
  | { type: "engine_thinking_block_start" }
  | { type: "engine_thinking_delta"; thinkingText: string }
  | {
      type: "engine_thinking_block_end";
      thinkingTotalTokens?: number;
      thinkingElapsedSeconds?: number;
      thinkingRedacted?: boolean;
    }
  | {
      type: "engine_extension_died";
      extensionName: string;
      exitCode: number | null;
      signal: string | null;
      stderrTail?: string[];
    }
  | {
      type: "engine_extension_respawned";
      extensionName: string;
      attemptNumber: number;
    }
  | { type: "engine_events_dropped"; count: number }
  | {
      type: "engine_extension_dead_permanent";
      extensionName: string;
      attemptNumber: number;
      stderrTail?: string[];
    }
  | EngineEventAsync;
