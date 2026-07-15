// Package session — translateToEngineEvent, the pure NormalizedEvent →
// EngineEvent translation function.
//
// Split from event_translation.go to keep that file under the 800-line cap.
// event_translation.go retains the Manager-bound event-routing methods (handleNormalizedEvent,
// handleRunExit, handleRunError) and the shared classifyErrorCategory helper;
// this file holds only the stateless translation switch, which takes no
// Manager receiver and is the natural extraction seam.
package session

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// translateToEngineEvent converts a NormalizedEvent to an EngineEvent.
func translateToEngineEvent(event types.NormalizedEvent, contextWindow int) types.EngineEvent {
	if event.Data == nil {
		return types.EngineEvent{Type: "engine_error", EventMessage: "nil event data"}
	}

	switch e := event.Data.(type) {
	case *types.TextChunkEvent:
		return types.EngineEvent{Type: "engine_text_delta", TextDelta: e.Text}

	case *types.ToolCallEvent:
		return types.EngineEvent{Type: "engine_tool_start", ToolName: e.ToolName, ToolID: e.ToolID}

	case *types.ToolCallUpdateEvent:
		return types.EngineEvent{Type: "engine_tool_update", ToolID: e.ToolID, ToolPartialInput: e.PartialInput}

	case *types.ToolCallCompleteEvent:
		idx := e.Index
		return types.EngineEvent{Type: "engine_tool_complete", ToolIndex: &idx}

	case *types.ToolResultEvent:
		return types.EngineEvent{Type: "engine_tool_end", ToolName: "", ToolID: e.ToolID, ToolResult: e.Content, ToolIsError: e.IsError, ToolResultImages: e.Images}

	case *types.ImageContentEvent:
		// A single image produced during the run — tool-returned or
		// provider-generated. The engine is a pass-through for images: it
		// emits the on-disk file path, never base64 bytes. Consumers render
		// or ignore it; the engine has no opinion (see CLAUDE.md § "The
		// typed-event corollary").
		return types.EngineEvent{
			Type:           "engine_image_content",
			ImagePath:      e.Path,
			ImageMediaType: e.MediaType,
			ImageSource:    e.Source,
			ImageToolID:    e.ToolID,
		}

	case *types.TaskCompleteEvent:
		var pct int
		if e.Usage.InputTokens != nil && contextWindow > 0 {
			pct = *e.Usage.InputTokens * 100 / contextWindow
			if pct > 100 {
				pct = 100
			}
		}
		return types.EngineEvent{
			Type: "engine_status",
			Fields: &types.StatusFields{
				State:             "idle",
				SessionID:         e.SessionID,
				RunCostUsd:        e.CostUsd,
				ContextWindow:     contextWindow,
				ContextPercent:    pct,
				PermissionDenials: e.PermissionDenials,
				NumTurns:          e.NumTurns,
				ConversationTurns: e.ConversationTurns,
			},
		}

	case *types.TaskSuspendEvent:
		// TaskSuspendEvent signals that a dispatched agent's LLM run ended
		// without completing the dispatch (the agent is parked, waiting for
		// child completions or a revive message). Emit a typed wire event so
		// clients can update the agent-state indicator to show suspended/idle.
		// The dispatch remains alive; TaskCompleteEvent (and the normal idle
		// engine_status) fires only when the agent truly finishes after revival.
		return types.EngineEvent{
			Type:                     "engine_task_suspended",
			TaskSuspendAwaitingCount: len(e.AwaitingDispatchIDs),
		}

	case *types.ErrorEvent:
		return types.EngineEvent{
			Type:          "engine_error",
			EventMessage:  e.ErrorMessage,
			ErrorCode:     e.ErrorCode,
			ErrorCategory: string(classifyErrorCategory(e.ErrorCode)),
			Retryable:     e.Retryable,
			RetryAfterMs:  e.RetryAfterMs,
			HttpStatus:    e.HttpStatus,
		}

	case *types.UsageEvent:
		var pct int
		if e.Usage.InputTokens != nil {
			window := contextWindow
			if window <= 0 {
				window = conversation.DefaultContext
			}
			pct = *e.Usage.InputTokens * 100 / window
			if pct > 100 {
				pct = 100
			}
		}
		return types.EngineEvent{
			Type: "engine_message_end",
			EndUsage: &types.MessageEndUsage{
				InputTokens:    derefInt(e.Usage.InputTokens),
				OutputTokens:   derefInt(e.Usage.OutputTokens),
				ContextPercent: pct,
				EntryID:        e.EntryID,
				UserEntryID:    e.UserEntryID,
			},
		}

	case *types.SessionDeadEvent:
		return types.EngineEvent{
			Type:       "engine_dead",
			ExitCode:   e.ExitCode,
			Signal:     e.Signal,
			StderrTail: e.StderrTail,
		}

	case *types.PermissionRequestEvent:
		return types.EngineEvent{
			Type:          "engine_permission_request",
			QuestionID:    e.QuestionID,
			PermToolName:  e.ToolName,
			PermToolDesc:  e.ToolDescription,
			PermToolInput: e.ToolInput,
			PermOptions:   e.Options,
		}

	case *types.PlanModeChangedEvent:
		// The slug is derived from the path here (rather than threaded
		// through every emitter) so a single helper owns the
		// path-basename-stripping logic. Legacy hex-hash filenames
		// round-trip as their hex string; new word-slug files surface
		// the human-readable "adj-verb-noun" form. Empty path → empty
		// slug, by design. Emitters that populate PlanSlug directly win
		// over the fallback.
		slug := e.PlanSlug
		if slug == "" {
			slug = types.PlanSlugFromPath(e.PlanFilePath)
		}
		return types.EngineEvent{
			Type:             "engine_plan_mode_changed",
			PlanModeEnabled:  e.Enabled,
			PlanModeFilePath: e.PlanFilePath,
			PlanModeSlug:     slug,
		}

	case *types.PlanFileWrittenEvent:
		// Emitted when a Write/Edit landed on the canonical plan file. Same
		// slug-fallback semantics as PlanModeChangedEvent so consumers always
		// receive a populated display string. The Operation discriminator
		// ("created"/"updated") tells consumers which marker to render.
		slug := e.PlanSlug
		if slug == "" {
			slug = types.PlanSlugFromPath(e.PlanFilePath)
		}
		return types.EngineEvent{
			Type:               "engine_plan_file_written",
			PlanWriteOperation: e.Operation,
			PlanModeFilePath:   e.PlanFilePath,
			PlanModeSlug:       slug,
		}

	case *types.PlanProposalEvent:
		// PlanProposalEvent is the workflow-level counterpart to
		// PlanModeChangedEvent: it fires when the model *proposes* a
		// plan-mode transition (e.g. by calling ExitPlanMode) but the
		// actual state change is deferred to the consumer's user-approval
		// chokepoint. Same slug-fallback semantics as PlanModeChangedEvent
		// so consumers receive a usable display string regardless of
		// whether the emitter populated PlanSlug explicitly.
		slug := e.PlanSlug
		if slug == "" {
			slug = types.PlanSlugFromPath(e.PlanFilePath)
		}
		return types.EngineEvent{
			Type:             "engine_plan_proposal",
			PlanProposalKind: e.Kind,
			PlanModeFilePath: e.PlanFilePath,
			PlanModeSlug:     slug,
		}

	case *types.PlanModeAutoExitEvent:
		// PlanModeAutoExitEvent fires when the engine deterministically
		// synthesizes an ExitPlanMode call at end-of-turn because the
		// model ended a plan-mode run without invoking ExitPlanMode or
		// AskUserQuestion (issue #187). Sibling to PlanProposalEvent —
		// both surface the plan-approval card, but this event
		// additionally tells consumers the exit was engine-driven
		// rather than model-driven. Same slug-fallback semantics so
		// consumers always receive a populated display string.
		slug := e.PlanSlug
		if slug == "" {
			slug = types.PlanSlugFromPath(e.PlanFilePath)
		}
		return types.EngineEvent{
			Type:                       "engine_plan_mode_auto_exit",
			PlanModeAutoExitStopReason: e.StopReason,
			PlanModeFilePath:           e.PlanFilePath,
			PlanModeSlug:               slug,
			PlanModeAutoExitReason:     e.Reason,
			PlanModeAutoExitSessionID:  e.SessionID,
			PlanModeAutoExitRunID:      e.RunID,
		}

	case *types.StreamResetEvent:
		return types.EngineEvent{Type: "engine_stream_reset"}

	case *types.CompactingEvent:
		return types.EngineEvent{
			Type:                     "engine_compacting",
			CompactingActive:         e.Active,
			CompactingSummary:        e.Summary,
			CompactingMessagesBefore: e.MessagesBefore,
			CompactingMessagesAfter:  e.MessagesAfter,
			CompactingClearedBlocks:  e.ClearedBlocks,
			CompactingStrategy:       e.Strategy,
			CompactingMicroOnly:      e.MicroOnly,
		}

	case *types.ToolStalledEvent:
		return types.EngineEvent{Type: "engine_tool_stalled", ToolID: e.ToolID, ToolName: e.ToolName, ToolElapsed: e.Elapsed}

	case *types.RunStalledEvent:
		// Engine-wide progress watchdog tripped: this run made no
		// forward progress for longer than the configured threshold
		// and is about to be cancelled. Mirrors RunStalledEvent at the
		// EngineEvent layer so clients that subscribe to the
		// engine_-prefixed stream (desktop, iOS) see it the same way
		// they see engine_tool_stalled. Authoritative completion still
		// arrives via the follow-up engine_task_complete + engine_dead
		// (or idle) events — see RunStalledEvent doc for the contract.
		return types.EngineEvent{
			Type:                   "engine_run_stalled",
			RunStalledDuration:     e.StalledDuration,
			RunStalledLastActivity: e.LastActivity,
		}

	case *types.SteerInjectedEvent:
		// Surface mid-turn steer captures as a typed engine event so
		// clients can render a confirmation (divider, toast, log line).
		// The character count is enough for the UI; the message body is
		// already in the conversation as a user turn and does not need
		// to be echoed back over the wire.
		return types.EngineEvent{Type: "engine_steer_injected", SteerMessageLength: e.MessageLength}

	case *types.PromptInjectedEvent:
		// Engine-initiated prompt (extension ctx.sendPrompt): live clients
		// must render the turn from this event — no client submitted it, so
		// no client did an optimistic insert. The full text crosses the wire
		// deliberately (unlike the steer confirmation): it IS the turn.
		// Exception: Kind=="agent_completion" means this is an internal
		// machine-to-machine signal (a child agent's result routed back to its
		// parent). Clients must NOT render agent_completion injections as user
		// bubbles — they are dispatch callbacks, not user-authored turns.
		return types.EngineEvent{Type: "engine_prompt_injected", InjectedPrompt: e.Prompt, InjectedPromptOrigin: e.Origin, InjectedPromptKind: e.Kind}

	case *types.ModelFallbackEvent:
		// Surface the model-fallback workflow signal as a typed engine
		// event so clients can render an indicator. The desktop and iOS
		// renderers display a small ⚠ glyph on the affected engine
		// instance pill; headless harnesses may abort, retry, or route
		// elsewhere. The engine has no opinion — see CLAUDE.md §
		// "The typed-event corollary" for the rule that the typed event
		// is the engine's *complete* signaling surface (no parallel
		// stream-content mutation).
		return types.EngineEvent{
			Type:                   "engine_model_fallback",
			FallbackRequestedModel: e.RequestedModel,
			FallbackModel:          e.FallbackModel,
			FallbackReason:         e.Reason,
		}

	case *types.ThinkingBlockStartEvent:
		// Reasoning block began. No payload — arrival is the signal.
		// Consumers create a "thinking" affordance and start a pulse/elapsed
		// timer. See normalized_event.go for the per-block emission contract.
		return types.EngineEvent{Type: "engine_thinking_block_start"}

	case *types.ThinkingDeltaEvent:
		// Incremental reasoning text — peer of engine_text_delta for the
		// thinking channel. Only reaches here when ThinkingConfig.StreamDeltas
		// is on (the runloop gates emission); boundaries always flow.
		return types.EngineEvent{Type: "engine_thinking_delta", ThinkingText: e.Text}

	case *types.ThinkingBlockEndEvent:
		// Reasoning block finished. Carries a summary so consumers can render
		// "💭 Thought for Ns" without having accumulated deltas (and so
		// delta-disabled / history-loaded consumers still get a summary).
		return types.EngineEvent{
			Type:                   "engine_thinking_block_end",
			ThinkingTotalTokens:    e.TotalTokens,
			ThinkingElapsedSeconds: e.ElapsedSeconds,
			ThinkingRedacted:       e.Redacted,
		}

	case *types.ContextBreakdownEvent:
		return types.EngineEvent{
			Type: "engine_context_breakdown",
			ContextBreakdown: &types.ContextBreakdownPayload{
				Categories:          e.Categories,
				ContextWindow:       e.ContextWindow,
				TotalTokens:         e.TotalTokens,
				APIReportedTotal:    e.APIReportedTotal,
				Unaccounted:         e.Unaccounted,
				CacheReadTokens:     e.CacheReadTokens,
				CacheCreationTokens: e.CacheCreationTokens,
				Model:               e.Model,
				AggregateCostUsd:    e.AggregateCostUsd,
				ModelBreakdown:      e.ModelBreakdown,
			},
		}

	default:
		return types.EngineEvent{}
	}
}
