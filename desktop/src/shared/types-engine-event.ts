// EngineEvent — the engine's outbound wire event union (engine_* types).
//
// Extracted from types-engine.ts to keep that file under the 600-line cap.
// Re-exported from types-engine.ts so existing
// `import type { EngineEvent } from './types-engine'` sites keep working.
//
// The union references shared engine types (AgentStateUpdate, StatusFields,
// SessionStatus, ResourceItem, ResourceDelta, EngineCommandListing, Message),
// imported below from their defining modules.
import type {
  AgentStateUpdate,
  StatusFields,
  SessionStatus,
  ResourceItem,
  ResourceDelta,
  EngineCommandListing,
  ContextBreakdownPayload,
} from './types-engine'

export type EngineEvent =
  | { type: 'engine_agent_state'; agents: AgentStateUpdate[] }
  | { type: 'engine_status'; fields: StatusFields; metadata?: Record<string, unknown> }
  | { type: 'engine_session_status'; sessionStatus: SessionStatus; metadata?: Record<string, unknown> }
  | { type: 'engine_working_message'; message: string; metadata?: Record<string, unknown> }
  | { type: 'engine_notify'; message: string; level: 'info' | 'warning' | 'error'; metadata?: Record<string, unknown> }
  | { type: 'engine_dialog'; dialogId: string; method: 'select' | 'confirm' | 'input'; title: string; message?: string; options?: string[]; defaultValue?: string }
  // engine_elicitation_request — an extension called ctx.elicit(). The engine
  // fans this to every connected client expecting one to respond with an
  // `elicitation_response` command (or a peer extension's elicitation_request
  // hook to answer). `mode` selects the renderer ("approval", "select", ...);
  // `schema` describes what is being requested. Mirrors the Go fields
  // ElicitRequestID/ElicitSchema/ElicitURL/ElicitMode in engine_event.go.
  | { type: 'engine_elicitation_request'; requestId: string; schema?: Record<string, unknown>; url?: string; elicitMode?: string }
  // `metadata` is an opaque pass-through map the harness sets via ctx.emit
  // that the engine forwards verbatim. The desktop renderer honors
  // `metadata.dedupKey` (string) to suppress repeated harness messages
  // within an engine-instance scrollback — see engine-event-slice.ts. The
  // convention is renderer-honored, not engine-enforced; other extensions
  // may pick their own keys (namespace as `<extensionName>:<messageKey>`).
  | { type: 'engine_harness_message'; message: string; source?: string; metadata?: Record<string, unknown> }
  | { type: 'engine_text_delta'; text: string }
  | { type: 'engine_message_end'; usage: { inputTokens: number; outputTokens: number; contextPercent: number; cost: number } }
  | { type: 'engine_tool_start'; toolName: string; toolId: string }
  | { type: 'engine_tool_end'; toolId: string; result?: string; isError?: boolean }
  // engine_image_content — a single image produced during a run, either
  // tool-returned (imageSource 'tool', imageToolId set to the producing tool
  // call) or provider-generated (imageSource 'provider', imageToolId empty).
  // imagePath is the on-disk FILE PATH under the conversation's images/
  // directory; the engine never puts base64 on the wire. The main-process
  // control plane translates this to the `image_content` NormalizedEvent the
  // renderer's event-slice-images materializer consumes. Mirror of the Go
  // EngineEvent Image* fields (engine/internal/types/engine_event.go).
  | { type: 'engine_image_content'; imagePath: string; imageMediaType: string; imageSource: string; imageToolId?: string }
  | { type: 'engine_tool_update'; toolId: string; partialInput: string }
  | { type: 'engine_tool_complete'; index?: number }
  | { type: 'engine_dead'; exitCode: number | null; signal: string | null; stderrTail: string[] }
  | { type: 'engine_error'; message: string; errorCode?: string; errorCategory?: string; retryable?: boolean; retryAfterMs?: number; httpStatus?: number }
  | { type: 'engine_permission_request'; questionId: string; permToolName: string; permToolDescription?: string; permToolInput?: Record<string, unknown>; permOptions: Array<{ id: string; label: string; kind?: string }> }
  | { type: 'engine_plan_mode_changed'; planModeEnabled: boolean; planFilePath?: string; planSlug?: string }
  // engine_oidc_login_url — delivered to the client that issued
  // oidc_begin_login. Interactive PKCE carries oidcAuthorizationUrl (open
  // it in a browser; the engine's loopback callback completes the
  // exchange); device-code carries oidcUserCode + oidcVerificationUri
  // (display them; the engine polls to completion).
  | { type: 'engine_oidc_login_url'; oidcAuthorizationUrl?: string; oidcUserCode?: string; oidcVerificationUri?: string }
  // engine_oidc_identity — complete SNAPSHOT of the operator's OIDC
  // identity state, broadcast on every login/logout transition and
  // answered to oidc_identity queries. Consumers REPLACE their local
  // identity view with the payload; claim fields are absent when signed
  // out.
  | { type: 'engine_oidc_identity'; oidcSignedIn: boolean; oidcProvider?: string; oidcSubject?: string; oidcUsername?: string; oidcDisplayName?: string }
  // engine_plan_file_written fires when a Write/Edit lands on the canonical
  // plan file during plan mode — the accurate trigger for the "plan created /
  // updated" conversation marker (the file now exists with content, so the
  // marker is correctly positioned and any link resolves). `planWriteOperation`
  // discriminates "created" (first content) from "updated" (a revision).
  | { type: 'engine_plan_file_written'; planWriteOperation: 'created' | 'updated' | string; planFilePath?: string; planSlug?: string }
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
  | { type: 'engine_plan_proposal'; planProposalKind: 'exit' | string; planFilePath?: string; planSlug?: string }
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
  | { type: 'engine_plan_mode_auto_exit'; stopReason: string; planFilePath?: string; planSlug?: string; reason?: string; sessionId?: string; runId?: string }
  | { type: 'engine_stream_reset' }
  | { type: 'engine_compacting'; active: boolean; summary?: string; messagesBefore?: number; messagesAfter?: number; clearedBlocks?: number; strategy?: string; microOnly?: boolean }
  | { type: 'engine_tool_stalled'; toolId: string; toolName: string; toolElapsed: number }
  // Mid-turn steer-drain confirmation. Engine emits this after the
  // runloop drainSteer helper captures a steer message (queued via the
  // steer channel) and injects it into the conversation as a user turn
  // before the next LLM call. `steerMessageLength` is the character
  // count; the body is not echoed back over the wire because it is
  // already part of the conversation. See
  // engine/internal/types/normalized_event.go (SteerInjectedEvent).
  | { type: 'engine_steer_injected'; steerMessageLength: number }
  // engine_run_stalled — advisory event emitted by the run-progress watchdog
  // when a run records no forward progress for longer than the configured
  // RunStall threshold. The authoritative completion signal is the follow-up
  // task_complete; this event is for observability only.
  | { type: 'engine_run_stalled'; runStalledDuration: number; runStalledLastActivity?: string }
  // engine_model_fallback — workflow signal emitted by the engine when
  // it fell back to its configured defaultModel because the requested
  // model didn't resolve to a provider. Mirrors the underlying
  // ModelFallbackEvent NormalizedEvent variant. The desktop renders a
  // small ⚠ glyph on the affected engine instance pill via the
  // engineModelFallbacks store map; iOS receives the fact through the
  // snapshot path (RemoteTabState.conversationInstances[i].modelFallback)
  // rather than as a live RemoteEvent. See CLAUDE.md §
  // "The typed-event corollary" for the broader rule.
  | { type: 'engine_model_fallback'; fallbackRequestedModel: string; fallbackModel: string; fallbackReason: string }
  // Extended-thinking events (issue #158). Surface the model's reasoning
  // activity so consumers can distinguish active reasoning from a stall and
  // render a "thinking" view. Emitted only when the provider streams reasoning
  // (Anthropic extended thinking); a thinking block is OPTIONAL per turn.
  // Boundaries (start/end) always emit; engine_thinking_delta is gated by the
  // engine's ThinkingConfig.StreamDeltas (default on). See
  // engine/internal/types/normalized_event.go (Thinking*Event).
  | { type: 'engine_thinking_block_start' }
  | { type: 'engine_thinking_delta'; thinkingText: string }
  | { type: 'engine_thinking_block_end'; thinkingTotalTokens?: number; thinkingElapsedSeconds?: number; thinkingRedacted?: boolean }
  | { type: 'engine_extension_died'; extensionName: string; exitCode: number | null; signal: string | null; stderrTail?: string[] }
  | { type: 'engine_extension_respawned'; extensionName: string; attemptNumber: number }
  | { type: 'engine_events_dropped'; count: number }
  | { type: 'engine_extension_dead_permanent'; extensionName: string; attemptNumber: number; stderrTail?: string[] }
  // ─── Async-trigger events (D-010 / D-011) ───
  //
  // The engine emits these for every webhook and schedule fire plus
  // every registration/deregistration so the desktop / iOS can render
  // an audit-log panel of "what's declared" and "what just fired".
  // The desktop does NOT act on these (they're observation-only);
  // they're typed here so future UI work has the shape ready.
  //
  // Shared fields across the variants:
  //   asyncKind:        "webhook" | "schedule"
  //   asyncId:          route path (webhook) or job id (schedule)
  //   asyncOrigin:      "init" | "runtime" — set on lifecycle events
  //   asyncReason:      negative-path discriminator
  //   asyncDecl:        the original declaration JSON, redacted of secrets
  //   asyncRequestId:   webhook correlation id (received → responded)
  //   asyncMethod:      HTTP method (webhook)
  //   asyncPath:        HTTP path (mirrors asyncId for webhooks)
  //   asyncStatus:      HTTP response status (webhook)
  //   asyncDurationMs:  elapsed time of the fire
  | { type: 'engine_webhook_received'; asyncKind: 'webhook'; asyncId: string; asyncRequestId: string; asyncMethod: string; asyncPath: string }
  | { type: 'engine_webhook_authenticated'; asyncKind: 'webhook'; asyncId: string; asyncRequestId: string; asyncMethod: string; asyncPath: string }
  | { type: 'engine_webhook_handler_error'; asyncKind: 'webhook'; asyncId: string; asyncRequestId: string; asyncMethod: string; asyncPath: string; asyncStatus: number; asyncReason: string; asyncDurationMs: number }
  | { type: 'engine_webhook_responded'; asyncKind: 'webhook'; asyncId: string; asyncRequestId: string; asyncMethod: string; asyncPath: string; asyncStatus: number; asyncDurationMs: number }
  | { type: 'engine_webhook_registered'; asyncKind: 'webhook'; asyncId: string; asyncOrigin: 'init' | 'runtime'; asyncDecl?: unknown }
  | { type: 'engine_webhook_deregistered'; asyncKind: 'webhook'; asyncId: string; asyncOrigin: 'init' | 'runtime'; asyncDecl?: unknown }
  | { type: 'engine_schedule_fired'; asyncKind: 'schedule'; asyncId: string; asyncDurationMs: number }
  | { type: 'engine_schedule_skipped'; asyncKind: 'schedule'; asyncId: string; asyncReason: string }
  | { type: 'engine_schedule_failed'; asyncKind: 'schedule'; asyncId: string; asyncReason: string; asyncDurationMs: number }
  | { type: 'engine_schedule_registered'; asyncKind: 'schedule'; asyncId: string; asyncOrigin: 'init' | 'runtime'; asyncDecl?: unknown }
  | { type: 'engine_schedule_deregistered'; asyncKind: 'schedule'; asyncId: string; asyncOrigin: 'init' | 'runtime'; asyncDecl?: unknown }
  | { type: 'engine_async_fire_dropped'; asyncKind: 'webhook' | 'schedule'; asyncId: string; asyncReason: string }
  // engine_command_result is emitted at the end of every Manager.SendCommand
  // dispatch — success (CommandError empty), extension-command failure
  // (CommandError = the error message), and unknown command (CommandError =
  // "unknown_command"). The `command` field carries the bare name so a
  // consumer can switch on it without reparsing prose. The desktop's prompt
  // pipeline awaits this event to decide between "dispatch landed, draw
  // the divider" and "engine disclaims, fall through to `.md` expansion".
  | { type: 'engine_command_result'; message?: string; command?: string; commandError?: string }
  // engine_export carries the rendered export output for a /export command.
  // The engine's dispatchExport emits this event with the rendered string
  // on `message` BEFORE the matching engine_command_result, so consumers
  // can capture the payload and persist it / surface a save dialog.
  // `exportFormat` is the format the engine resolved from the /export args
  // (markdown | json | html | jsonl; markdown when args is empty) — consumers
  // use it to pick a file extension / MIME type directly rather than sniffing
  // the payload bytes. See engine/internal/session/command_dispatch.go's
  // EngineEventExport constant for the wire type string declaration.
  | { type: 'engine_export'; message: string; exportFormat?: string }
  // engine_command_registry is a complete SNAPSHOT of the session's
  // extension-registered slash commands. Emitted at session_start (after
  // extensions wire up) and on every subsequent change (mid-session
  // RegisterCommand, hot reload, etc.). Consumers REPLACE their cached
  // routing-hint set with this payload. Empty `commands` is the authoritative
  // "no extension commands live for this session" signal.
  | { type: 'engine_command_registry'; commands: EngineCommandListing[] }
  // engine_early_stop_decision_request is the wire-protocol surface for the
  // before_early_stop_decision hook. Promotes the hook to the socket so
  // socket-only harnesses (desktop, custom UIs, headless tooling) can
  // participate without running a subprocess extension. The engine emits this
  // event after the model emits end_turn / stop AND after the extension-side
  // hook returned no opinion. Consumers must respond via the
  // `early_stop_decision_response` client command, supplying the same
  // fields the subprocess hook would return (all optional). The engine
  // waits at most 100ms for a response; a missed deadline is treated as
  // "no opinion" and the run proceeds with the existing merge logic.
  //
  // Field semantics mirror engine/internal/extension/EarlyStopDecisionInfo
  // verbatim; see docs/hooks/reference.md for the canonical descriptions.
  | {
      type: 'engine_early_stop_decision_request'
      earlyStopRequestId: string
      earlyStopRunId: string
      earlyStopModel: string
      earlyStopTurnNumber: number
      earlyStopStopReason: string
      earlyStopCumulativeOutput: number
      earlyStopBudget: number
      earlyStopThresholdPct: number
      earlyStopContinuationCount: number
      earlyStopMaxContinuations: number
      earlyStopLastContinuationDelta: number
      earlyStopWouldContinue: boolean
      earlyStopIsSubagent?: boolean
    }
  // engine_llm_call is the lightweight-inference observability event,
  // emitted exactly once per successful ctx.LLMCall invocation. Carries
  // model / provider / latency / token / cost / jsonMode metadata —
  // never the prompt text or response content (privacy-by-default for
  // harness-internal classification prompts). The desktop is observation-
  // only; it does NOT need to act on this, but the variant is typed so
  // any future cost-summary or telemetry-rendering work has the shape
  // ready. See engine/internal/types/types.go for the canonical Go
  // definition.
  | {
      type: 'engine_llm_call'
      llmCallModel: string
      llmCallProvider: string
      llmCallLatencyMs: number
      llmCallInputTokens: number
      llmCallOutputTokens: number
      llmCallCost: number
      llmCallJsonMode?: boolean
    }
  // engine_dispatch_start is emitted on the parent session's event stream when
  // an extension-initiated dispatch begins. Carries the agent name, task, model,
  // child session ID, and nesting depth/parent. Observation-only — harnesses can
  // use this and engine_dispatch_end to persist dispatch records or surface
  // dispatch status (including nested hierarchy).
  | {
      type: 'engine_dispatch_start'
      dispatchAgent: string
      dispatchTask: string
      dispatchModel: string
      dispatchSessionId: string
      dispatchDepth?: number
      dispatchParentId?: string
      // Unique ID for this dispatch invocation. Consumers match dispatch_start
      // with dispatch_end and join a child's dispatchParentId to its parent's
      // dispatchId to reconstruct the dispatch tree.
      dispatchId?: string
    }
  // engine_dispatch_end is emitted when an extension-initiated dispatch completes
  // (success, error, or recall). Carries telemetry: exit code, elapsed time,
  // cost, tokens, tool count, and nesting depth/parent.
  | {
      type: 'engine_dispatch_end'
      dispatchAgent: string
      dispatchExitCode: number
      dispatchElapsed: number
      dispatchCost: number
      dispatchInputTokens: number
      dispatchOutputTokens: number
      dispatchToolCount: number
      dispatchDepth?: number
      dispatchParentId?: string
      // Matches the dispatchId on the corresponding engine_dispatch_start.
      dispatchId?: string
      // The conversation ID the dispatched agent used. Set at end-time once
      // the child session has a real conversation ID.
      dispatchConversationId?: string
    }
  // engine_dispatch_activity streams a running dispatched (sub-)agent's
  // intra-turn activity — a tool call starting, a tool result returning, or a
  // chunk of streamed assistant text — to the parent session's event stream so
  // consumers can render the live sub-agent transcript without waiting for the
  // dispatch to complete. INCREMENTAL, append-by-key; NOT a snapshot, NOT
  // retained, NOT replayed on reconnect. The file-backed conversation transcript
  // (loaded via getConversation) is the snapshot authority that heals gaps.
  // dispatchAgentId routes the delta to the right agent/dispatch row (never the
  // parent conversation's own message stream); dispatchSeq orders deltas and
  // keys a streaming-text run; toolId keys tool entries (durable, also persisted,
  // so it survives reconcile).
  | {
      type: 'engine_dispatch_activity'
      dispatchAgentId: string
      dispatchConversationId: string
      dispatchActivityKind: 'text' | 'tool_start' | 'tool_end'
      dispatchSeq: number
      toolName?: string
      toolId?: string
      dispatchTextDelta?: string
      dispatchToolIsError?: boolean
      dispatchActivityTs?: number
    }
  // ─── Resource subsystem events (D-007) ───
  //
  // engine_resource_snapshot: emitted when a client subscribes to a resource
  // kind. Consumers REPLACE their local collection with resourceItems.
  //
  // engine_resource_delta: emitted when a producer publishes a change.
  // Consumers apply the delta incrementally.
  //
  // Both carry resourceKind and resourceSubId for subscription correlation.
  | {
      type: 'engine_resource_snapshot'
      resourceKind: string
      resourceSubId: string
      resourceItems: ResourceItem[]
    }
  | {
      type: 'engine_resource_delta'
      resourceKind: string
      resourceSubId: string
      resourceDelta: ResourceDelta
    }
  // ─── Notification events (D-009) ───
  //
  // engine_notification: emitted when an extension calls ctx.notify().
  // The push/pushTitle/pushBody fields trigger APNs delivery through the
  // relay when the mobile peer is not connected. The notifyKind/Title/Body
  // fields carry structured metadata for richer client handling.
  | {
      type: 'engine_notification'
      push: boolean
      pushTitle: string
      pushBody: string
      notifyKind: string
      notifyResourceId?: string
      notifyTitle: string
      notifyBody: string
      notifySound?: string
      notifyScope?: string
    }
  // ─── engine_intercept ───
  //
  // Fire-and-forget signal emitted when an extension calls ctx.intercept().
  // The engine routes the event to the target session's stream and attaches no
  // further semantics. Clients decide how to render and whether to act on the
  // level hint:
  //   "banner"   — informational, non-disruptive inline display
  //   "redirect" — urgent; client may abort the active run and re-prompt with message
  //
  // There is no "current intercept state" to query — this event fires exactly
  // once per ctx.intercept() call. Consumers must not accumulate or replace
  // state from it. See docs/protocol/server-events.md for the full field table.
  | {
      type: 'engine_intercept'
      interceptLevel: string
      interceptTitle: string
      interceptMessage: string
      interceptSource?: string
      interceptMetadata?: Record<string, unknown>
    }
  // ─── engine_context_breakdown ───
  //
  // Per-category token breakdown for the active run. Emitted once after
  // prompt assembly and again after the first usage-event reconciliation
  // (apiReportedTotal and unaccounted are populated on the second emit).
  // Advisory telemetry — the engine attaches no UI semantics; clients
  // render it as they see fit. Tier encodes how the count was obtained:
  //   "exact"       — provider native count-tokens endpoint (online)
  //   "local"       — tiktoken BPE, no network (OpenAI + offline path)
  //   "approximate" — char/4 heuristic, last resort
  | {
      type: 'engine_context_breakdown'
      contextBreakdown: ContextBreakdownPayload
    }
