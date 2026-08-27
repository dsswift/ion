// EngineEvent async-trigger, resource, and client-observation events.
//
// Extracted from types-engine-event.ts to keep the main wire-event union under
// the 600-line cap. EngineEvent includes this union unchanged, so consumers
// retain the same discriminated event surface.
import type {
  ContextBreakdownPayload,
  EngineCommandListing,
  ResourceDelta,
  ResourceItem,
} from "./types-engine";

export type EngineEventAsync =
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
  //   asyncMissedSlot:  RFC3339 UTC timestamp of the missed schedule slot (schedule)
  //   asyncHadMarker:   whether a last-run marker existed when the miss was detected (schedule)
  | {
      type: "engine_webhook_received";
      asyncKind: "webhook";
      asyncId: string;
      asyncRequestId: string;
      asyncMethod: string;
      asyncPath: string;
    }
  | {
      type: "engine_webhook_authenticated";
      asyncKind: "webhook";
      asyncId: string;
      asyncRequestId: string;
      asyncMethod: string;
      asyncPath: string;
    }
  | {
      type: "engine_webhook_handler_error";
      asyncKind: "webhook";
      asyncId: string;
      asyncRequestId: string;
      asyncMethod: string;
      asyncPath: string;
      asyncStatus: number;
      asyncReason: string;
      asyncDurationMs: number;
    }
  | {
      type: "engine_webhook_responded";
      asyncKind: "webhook";
      asyncId: string;
      asyncRequestId: string;
      asyncMethod: string;
      asyncPath: string;
      asyncStatus: number;
      asyncDurationMs: number;
    }
  | {
      type: "engine_webhook_registered";
      asyncKind: "webhook";
      asyncId: string;
      asyncOrigin: "init" | "runtime";
      asyncDecl?: unknown;
    }
  | {
      type: "engine_webhook_deregistered";
      asyncKind: "webhook";
      asyncId: string;
      asyncOrigin: "init" | "runtime";
      asyncDecl?: unknown;
    }
  | {
      type: "engine_schedule_fired";
      asyncKind: "schedule";
      asyncId: string;
      asyncDurationMs: number;
    }
  | {
      type: "engine_schedule_skipped";
      asyncKind: "schedule";
      asyncId: string;
      asyncReason: string;
    }
  | {
      type: "engine_schedule_failed";
      asyncKind: "schedule";
      asyncId: string;
      asyncReason: string;
      asyncDurationMs: number;
    }
  | {
      type: "engine_schedule_missed";
      asyncKind: "schedule";
      asyncId: string;
      asyncMissedSlot: string;
      asyncHadMarker: boolean;
    }
  | {
      type: "engine_schedule_registered";
      asyncKind: "schedule";
      asyncId: string;
      asyncOrigin: "init" | "runtime";
      asyncDecl?: unknown;
    }
  | {
      type: "engine_schedule_deregistered";
      asyncKind: "schedule";
      asyncId: string;
      asyncOrigin: "init" | "runtime";
      asyncDecl?: unknown;
    }
  // engine_schedule_unhosted: the last alive host for a (extension, jobID)
  // group was removed; the job will not fire until a new host re-registers
  // it. Consumers can alert on unexpected schedule gaps.
  | { type: "engine_schedule_unhosted"; asyncKind: "schedule"; asyncId: string }
  | {
      type: "engine_async_fire_dropped";
      asyncKind: "webhook" | "schedule";
      asyncId: string;
      asyncReason: string;
    }
  // engine_command_result is emitted at the end of every Manager.SendCommand
  // dispatch — success (CommandError empty), extension-command failure
  // (CommandError = the error message), and unknown command (CommandError =
  // "unknown_command"). The `command` field carries the bare name so a
  // consumer can switch on it without reparsing prose. The desktop's prompt
  // pipeline awaits this event to decide between "dispatch landed, draw
  // the divider" and "engine disclaims, fall through to `.md` expansion".
  | {
      type: "engine_command_result";
      message?: string;
      command?: string;
      commandError?: string;
    }
  // engine_export carries the rendered export output for a /export command.
  // The engine's dispatchExport emits this event with the rendered string
  // on `message` BEFORE the matching engine_command_result, so consumers
  // can capture the payload and persist it / surface a save dialog.
  // `exportFormat` is the format the engine resolved from the /export args
  // (markdown | json | html | jsonl; markdown when args is empty) — consumers
  // use it to pick a file extension / MIME type directly rather than sniffing
  // the payload bytes. See engine/internal/session/command_dispatch.go's
  // EngineEventExport constant for the wire type string declaration.
  | { type: "engine_export"; message: string; exportFormat?: string }
  // engine_command_registry is a complete SNAPSHOT of the session's
  // extension-registered slash commands. Emitted at session_start (after
  // extensions wire up) and on every subsequent change (mid-session
  // RegisterCommand, hot reload, etc.). Consumers REPLACE their cached
  // routing-hint set with this payload. Empty `commands` is the authoritative
  // "no extension commands live for this session" signal.
  | { type: "engine_command_registry"; commands: EngineCommandListing[] }
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
      type: "engine_early_stop_decision_request";
      earlyStopRequestId: string;
      earlyStopRunId: string;
      earlyStopModel: string;
      earlyStopTurnNumber: number;
      earlyStopStopReason: string;
      earlyStopCumulativeOutput: number;
      earlyStopBudget: number;
      earlyStopThresholdPct: number;
      earlyStopContinuationCount: number;
      earlyStopMaxContinuations: number;
      earlyStopLastContinuationDelta: number;
      earlyStopWouldContinue: boolean;
      earlyStopIsSubagent?: boolean;
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
      type: "engine_llm_call";
      llmCallModel: string;
      llmCallProvider: string;
      llmCallLatencyMs: number;
      llmCallInputTokens: number;
      llmCallOutputTokens: number;
      llmCallCost: number;
      llmCallJsonMode?: boolean;
    }
  // engine_dispatch_start is emitted on the parent session's event stream when
  // an extension-initiated dispatch begins. Carries the agent name, task, model,
  // child session ID, and nesting depth/parent. Observation-only — harnesses can
  // use this and engine_dispatch_end to persist dispatch records or surface
  // dispatch status (including nested hierarchy).
  | {
      type: "engine_dispatch_start";
      dispatchAgent: string;
      dispatchTask: string;
      dispatchModel: string;
      dispatchSessionId: string;
      dispatchDepth?: number;
      dispatchParentId?: string;
      // Unique ID for this dispatch invocation. Consumers match dispatch_start
      // with dispatch_end and join a child's dispatchParentId to its parent's
      // dispatchId to reconstruct the dispatch tree.
      dispatchId?: string;
    }
  // engine_dispatch_end is emitted when an extension-initiated dispatch completes
  // (success, error, or recall). Carries telemetry: exit code, elapsed time,
  // cost, tokens, tool count, and nesting depth/parent.
  | {
      type: "engine_dispatch_end";
      dispatchAgent: string;
      dispatchExitCode: number;
      dispatchElapsed: number;
      dispatchCost: number;
      dispatchInputTokens: number;
      dispatchOutputTokens: number;
      dispatchToolCount: number;
      dispatchDepth?: number;
      dispatchParentId?: string;
      // Matches the dispatchId on the corresponding engine_dispatch_start.
      dispatchId?: string;
      // The conversation ID the dispatched agent used. Set at end-time once
      // the child session has a real conversation ID.
      dispatchConversationId?: string;
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
      type: "engine_dispatch_activity";
      dispatchAgentId: string;
      dispatchConversationId: string;
      dispatchActivityKind: "text" | "tool_start" | "tool_end";
      dispatchSeq: number;
      toolName?: string;
      toolId?: string;
      dispatchTextDelta?: string;
      dispatchToolIsError?: boolean;
      dispatchActivityTs?: number;
    }
  // ─── Resource subsystem events (D-007) ───
  //
  // engine_resource_snapshot: emitted when a client subscribes to a resource
  // kind. Consumers REPLACE their local collection with resourceItems.
  //
  // engine_resource_delta: emitted when a producer publishes a change.
  // Consumers apply the delta incrementally.
  //
  // engine_resource_item: emitted in response to a resource_get command.
  // Carries the full content of a single item fetched on demand.
  //
  // engine_resource_snapshot and engine_resource_delta carry resourceSubId
  // for subscription correlation. All three carry resourceKind.
  | {
      type: "engine_resource_snapshot";
      resourceKind: string;
      resourceSubId: string;
      resourceItems: ResourceItem[];
      resourceProducers?: string[];
    }
  | {
      type: "engine_resource_delta";
      resourceKind: string;
      resourceSubId: string;
      resourceDelta: ResourceDelta;
    }
  | {
      type: "engine_resource_item";
      resourceKind: string;
      resourceItem: ResourceItem;
    }
  // ─── Notification events (D-009) ───
  //
  // engine_notification: emitted when an extension calls ctx.notify().
  // The push/pushTitle/pushBody fields trigger APNs delivery through the
  // relay when the mobile peer is not connected. The notifyKind/Title/Body
  // fields carry structured metadata for richer client handling.
  | {
      type: "engine_notification";
      push: boolean;
      pushTitle: string;
      pushBody: string;
      notifyKind: string;
      notifyResourceId?: string;
      notifyTitle: string;
      notifyBody: string;
      notifySound?: string;
      notifyScope?: string;
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
      type: "engine_intercept";
      interceptLevel: string;
      interceptTitle: string;
      interceptMessage: string;
      interceptSource?: string;
      interceptMetadata?: Record<string, unknown>;
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
      type: "engine_context_breakdown";
      contextBreakdown: ContextBreakdownPayload;
    };
