import type { AssistantMessagePayload, UsageData } from "./types-cli-events";
export * from "./types-cli-events";

// ─── Canonical Events (normalized from raw stream) ───
export type TaskCompletionReason =
  "normal" | "max_turns" | "aborted" | "backend_exit";

export interface BackgroundWorkItem {
  id: string;
  taskId?: string;
  source?: string;
  label?: string;
  command?: string;
  status: string;
  exitCode?: number;
  elapsedMs?: number;
  outputPath?: string;
  tail?: string;
  ts?: number;
}

export interface BackgroundWorkInfo {
  kind: string;
  deliveryMode: string;
  items: BackgroundWorkItem[];
  remainingTaskIds?: string[];
}
export type NormalizedEvent =
  | {
      type: "session_init";
      sessionId: string;
      tools: string[];
      model: string;
      mcpServers: Array<{ name: string; status: string }>;
      skills: string[];
      version: string;
      isWarmup?: boolean;
    }
  | { type: "text_chunk"; text: string }
  | { type: "tool_call"; toolName: string; toolId: string; index: number }
  | { type: "tool_call_update"; toolId: string; partialInput: string }
  | { type: "tool_call_complete"; index: number }
  | {
      type: "tool_result";
      toolId: string;
      content: string;
      isError: boolean;
      images?: Array<{ path: string; mediaType: string; source?: string }>;
      backgroundTaskId?: string;
    }
  | { type: "task_update"; message: AssistantMessagePayload }
  | {
      type: "task_complete";
      reason?: TaskCompletionReason | (string & {});
      result: string;
      lastText?: string;
      costUsd: number;
      durationMs: number;
      numTurns: number;
      conversationTurns?: number;
      usage: UsageData;
      sessionId: string;
      permissionDenials?: Array<{
        toolName: string;
        toolUseId: string;
        toolInput?: Record<string, unknown>;
      }>;
    }
  | {
      type: "error";
      message: string;
      isError: boolean;
      sessionId?: string;
      errorCode?: string;
      retryable?: boolean;
      retryAfterMs?: number;
      httpStatus?: number;
      stderrTail?: string[];
    }
  | {
      type: "session_dead";
      exitCode: number | null;
      signal: string | null;
      stderrTail: string[];
    }
  | {
      type: "rate_limit";
      status: string;
      resetsAt: number;
      rateLimitType: string;
    }
  | { type: "usage"; usage: UsageData }
  | {
      type: "permission_request";
      questionId: string;
      toolName: string;
      toolDescription?: string;
      toolInput?: Record<string, unknown>;
      options: Array<{ id: string; label: string; kind?: string }>;
    }
  | {
      type: "plan_mode_changed";
      enabled: boolean;
      planFilePath?: string;
      planSlug?: string;
    }
  | {
      type: "plan_mode_auto_exit";
      stopReason: string;
      planFilePath?: string;
      planSlug?: string;
      reason?: string;
      sessionId?: string;
      runId?: string;
    }
  | { type: "stream_reset" }
  | {
      type: "compacting";
      active: boolean;
      summary?: string;
      messagesBefore?: number;
      messagesAfter?: number;
      clearedBlocks?: number;
      strategy?: string;
      microOnly?: boolean;
    }
  | { type: "tool_stalled"; toolId: string; toolName: string; elapsed: number }
  | {
      type: "steer_injected";
      messageLength: number;
      clientMessageId?: string;
      entryId?: string;
      kind?: string;
      machineAuthored?: boolean;
    }
  // ctx.steerSelf accepted a fresh prompt because no owning run was live.
  // Distinct from steer_injected, which proves a live run-loop drain.
  | {
      type: "steer_degraded";
      messageLength: number;
      kind?: string;
      machineAuthored?: boolean;
    }
  // A steer arrived while the model was streaming text and the engine ended
  // that provider call early so the steer applies on the next turn. This is the
  // scheduling decision, not the delivery -- `steer_injected` still follows.
  // blocksKept counts the assistant content blocks preserved (nothing the model
  // produced is discarded), so a consumer renders the shortened message as an
  // intentional early stop rather than a truncation or an error.
  | {
      type: "steer_interrupted_stream";
      blocksKept?: number;
      queuedSteers?: number;
    }
  // The engine bounded an agent-state metadata payload that exceeded its
  // configured limits. Carries key names and byte counts only -- never the
  // offending content, which is by definition the multi-megabyte value that
  // made the original event undeliverable.
  | {
      type: "agent_state_clamped";
      agentName?: string;
      scope: string;
      clampedKeys?: string[];
      droppedKeys?: string[];
      originalBytes: number;
      clampedBytes: number;
      limitBytes: number;
    }
  // Extension-injected prompt (engine ctx.sendPrompt): no client submitted
  // this turn, so no client did an optimistic insert — the renderer appends
  // it as a user message. The text is also persisted as the run's user turn,
  // so a conversation reload shows the same content.
  // task_suspend — a run ended without completing. Either a dispatched agent
  // called ctx.suspend()/suspendUntilAll() and is parked on child completions
  // (awaitingDispatchIds), or the engine parked a session at a turn boundary
  // because it has outstanding notifying background bash commands
  // (awaitingTaskIds). The two sets are distinct: child agents vs shell
  // processes, and they revive differently — dispatch waits for ALL children,
  // background tasks wake the session on EACH completion.
  //
  // Note the engine's outbound wire (engine_task_suspended) carries only the
  // COUNTS of each set, not the ID arrays, so a consumer reading the socket
  // gets taskSuspendAwaitingCount / taskSuspendAwaitingTaskCount. These array
  // fields mirror the engine's internal NormalizedEvent shape and are the
  // contract the manifest pins.
  | {
      type: "task_suspend";
      awaitingDispatchIds?: string[];
      awaitingTaskIds?: string[];
    }
  // background_work_delivered — the engine collected completed background
  // work (bash tasks, agents) and injected their results into the
  // conversation. The actual content arrives as prompt_injected events;
  // this event carries the metadata so the renderer can show a collapsible
  // summary row grouping the delivered items.
  | {
      type: "background_work_delivered";
      entryId: string;
      content: string;
      work: BackgroundWorkInfo;
    }
  | {
      type: "prompt_injected";
      prompt: string;
      origin?: string;
      kind?: string;
      machineAuthored?: boolean;
    }
  | {
      type: "model_fallback";
      requestedModel: string;
      fallbackModel: string;
      reason: string;
    }
  // capability_unsupported — a requested feature (e.g. plan mode) is not
  // supported by the backend that would serve the run; the engine declined
  // the prompt cleanly (no run started, session stays idle). Mirrors
  // CapabilityUnsupportedEvent (engine/internal/types/normalized_event_capability.go).
  | {
      type: "capability_unsupported";
      capability: string;
      backend: string;
      reason: string;
    }
  | { type: "run_stalled"; stalledDuration: number; lastActivity?: string }
  | {
      type: "run_recovery";
      recoveryId: string;
      phase:
        "started" | "completed" | "skipped" | "exhausted" | "failed" | string;
      attempt?: number;
      maxAttempts?: number;
      reason?: string;
    }
  // Extended-thinking events (issue #158), normalized-stream layer. These are
  // the bare-name desktop-internal events the renderer consumes for PLAIN
  // conversations. The control plane (engine-control-plane-events.ts)
  // translates the engine-wire `engine_thinking_*` events into these so
  // `event-slice.ts` can materialize `role: 'thinking'` rows — mirroring the
  // extension-hosted path, where engine-event-slice.ts consumes the
  // `engine_thinking_*` events directly. A thinking block is OPTIONAL per turn;
  // boundaries (start/end) always arrive when reasoning happened, the delta may
  // be suppressed engine-side (summary-only path). See ThinkingBlock.tsx.
  | { type: "thinking_block_start" }
  | { type: "thinking_delta"; text: string }
  | {
      type: "thinking_block_end";
      totalTokens?: number;
      elapsedSeconds?: number;
      redacted?: boolean;
    }
  // Extension-surface events (WI-001: single-path collapse).
  // Previously handled only by the raw engine_* stream; now first-class
  // NormalizedEvent variants so every conversation flows through the
  // single normalized reducer (handleNormalizedEvent in event-slice.ts).
  // entryId / userEntryId: canonical persisted entry ids of the assistant
  // message this end closes and of the run-opening user turn. Consumers
  // re-key their live rows to them so a later history load
  // (SessionLoadMessage.id) dedups against the live rows.
  | {
      type: "message_end";
      inputTokens?: number;
      outputTokens?: number;
      contextPercent?: number;
      cost?: number;
      entryId?: string;
      userEntryId?: string;
    }
  // user_turn_persisted — the run-opening user turn's canonical persisted
  // tree-entry id, emitted before streaming so the optimistic user row can be
  // re-keyed even when the run never reaches a message_end (cancel, error).
  | {
      type: "user_turn_persisted";
      entryId: string;
      slashModelAlias?: string;
      slashModelEffective?: string;
      slashFrontmatter?: Record<string, unknown>;
    }
  | { type: "agent_state"; agents: import("./types-engine").AgentStateUpdate[] }
  // status — desktop-internal per-session status snapshot. Emitted by the
  // control plane (engine-control-plane-events.ts handleStatusEvent) from every
  // inbound engine_status, carrying the engine's full StatusFields. The renderer
  // REPLACES inst.statusFields wholesale (snapshot semantics, like agent_state).
  // This is the forwarding hop that populates inst.statusFields — without it the
  // field is null forever and every StatusBar slot that reads it (engine
  // identity, cost, backend badge, model-picker actual-model parenthetical)
  // renders nothing. Desktop-internal: no Go struct backing (StatusFields itself
  // is the synced shared type), so no contract-sync manifest entry.
  | { type: "status"; fields: import("./types-engine").StatusFields }
  | {
      type: "harness_message";
      message: string;
      dedupKey?: string;
      dedupMode?: "relocate";
      source?: string;
    }
  | { type: "working_message"; message: string }
  | { type: "notify"; message: string; level: string }
  | {
      type: "dialog";
      dialogId: string;
      method: string;
      title: string;
      options?: string[];
      defaultValue?: string;
    }
  // Extension elicitation (ctx.elicit). Translated from the engine-wire
  // `engine_elicitation_request` event by engine-control-plane-events.ts so
  // the single normalized reducer (event-slice.ts) can push it onto the
  // active instance's elicitationQueue.
  | {
      type: "elicitation_request";
      requestId: string;
      mode: string;
      schema?: Record<string, unknown>;
      url?: string;
    }
  | { type: "extension_died"; extensionName: string }
  | {
      type: "extension_respawned";
      extensionName: string;
      attemptNumber: number;
    }
  | {
      type: "extension_dead_permanent";
      extensionName: string;
      attemptNumber: number;
    }
  | { type: "events_dropped"; count: number }
  // image_content — a single image produced during a run, either returned by a
  // tool (source 'tool', toolId set) or generated by the provider (source
  // 'provider', toolId empty). Path is the on-disk file the engine saved under
  // the conversation's images/ directory; the engine never sends base64 on the
  // wire. Rendered inline and surfaced in the attachments panel.
  | {
      type: "image_content";
      path: string;
      mediaType: string;
      source: string;
      toolId?: string;
      contentHash?: string;
    }
  // Dispatch telemetry (n-tier nested dispatch). Emitted by the control plane
  // from engine_dispatch_start/end so the renderer can record dispatch depth
  // and parent linkage for tree rendering in the AgentPanel.
  | {
      type: "dispatch_start";
      dispatchAgent: string;
      dispatchTask: string;
      dispatchModel: string;
      dispatchSessionId: string;
      dispatchDepth: number;
      dispatchParentId: string;
      dispatchId: string;
    }
  | {
      type: "dispatch_end";
      dispatchAgent: string;
      dispatchExitCode: number;
      dispatchElapsed: number;
      dispatchCost: number;
      dispatchInputTokens?: number;
      dispatchOutputTokens?: number;
      dispatchToolCount?: number;
      dispatchDepth: number;
      dispatchParentId: string;
      dispatchId: string;
      dispatchConversationId?: string;
    }
  // Cross-cutting events (WI-001): previously handled via raw IPC.ENGINE_EVENT,
  // now routed through the normalized stream so the renderer has a single
  // subscription. These are desktop-internal variants with no Go struct backing;
  // they are emitted by wireEngineBridgeEvents (main process) and consumed by
  // handleCrossNormalizedEvent (renderer) without touching conversation state.
  // The `tabId` carried on the normalized-event envelope is the session key
  // (bare tabId for session events, empty string for workspace-scoped events).
  | {
      type: "command_registry";
      commands: Array<{ name: string; description?: string }>;
    }
  | { type: "command_result"; command: string; commandError?: string }
  | {
      type: "resource_snapshot";
      resourceKind: string;
      resourceSubId?: string;
      resourceItems: import("./types-engine").ResourceItem[];
      resourceProducers?: string[];
    }
  | {
      type: "resource_delta";
      resourceKind: string;
      resourceDelta: import("./types-engine").ResourceDelta;
    }
  | {
      type: "resource_item";
      resourceKind: string;
      resourceItem: import("./types-engine").ResourceItem;
    }
  | {
      type: "engine_notification";
      notificationTitle: string;
      notificationBody: string;
      notificationLevel: string;
    }
  // dispatch_activity — a running dispatched (sub-)agent's intra-turn transcript
  // delta (tool start/end, streamed text), bridged from the engine's
  // engine_dispatch_activity (event-wiring.ts). Cross-cutting: the agent popup
  // folds it into the per-dispatch transcript cache keyed by
  // dispatchAgentId/conversationId; it must never append to the main conversation
  // message stream. INCREMENTAL/append-by-key — see agent-dispatch-activity.ts.
  | {
      type: "dispatch_activity";
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
  // context_breakdown — per-category token breakdown from engine_context_breakdown.
  // Emitted after prompt assembly; reconciled (apiReportedTotal/unaccounted) after
  // the first usage event. Desktop-internal: translated from the engine wire in
  // event-wiring.ts and stored on the active instance (event-slice.ts case
  // 'context_breakdown') so the Status Drawer can render it synchronously.
  | {
      type: "context_breakdown";
      categories: import("./types-engine").ContextBreakdownCategory[];
      contextWindow: number;
      totalTokens: number;
      apiReportedTotal?: number;
      unaccounted?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      model: string;
      occupancyTokens?: number;
      aggregateCostUsd?: number;
      modelBreakdown?: import("./types-engine").ModelBreakdown[];
    }
  | {
      type: "background_task_started";
      taskId: string;
      command: string;
      startedAt: number;
      notifyOnComplete?: boolean;
    }
  | {
      type: "background_task_terminal";
      taskId: string;
      status: string;
      exitCode?: number;
      elapsedMs?: number;
      command?: string;
      outputPath?: string;
      tail?: string;
    }
  | {
      type: "session_work_stopped";
      scope: string;
      cancelledRunId?: string;
      recalledDispatchIds?: string[];
      stoppedBackgroundTaskIds?: string[];
      killedAgentProcessCount?: number;
    }
  // background_task_complete — a background bash command reached a terminal
  // state. Desktop-internal: translated from engine_background_task_complete
  // in event-wiring.ts. The Studio state cache and renderer consume it for the
  // background-work visualization; it never appends to conversation messages.
  | {
      type: "background_task_complete";
      taskId: string;
      status: string;
      exitCode: number;
      elapsedMs: number;
      command?: string;
      tail?: string;
      outputPath?: string;
      remainingTaskIds?: string[];
    };
