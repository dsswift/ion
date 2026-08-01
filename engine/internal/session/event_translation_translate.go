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
		// ContextPercent / ContextTokens are deliberately NOT stamped here.
		// TaskCompleteEvent.Usage is CUMULATIVE run billing (summed across
		// every turn, see backend.cumulativeUsage), which is a different
		// quantity from context-window occupancy. Conflating the two is what
		// made a 227k-token conversation report 0% at idle. The authoritative
		// idle figure is recomputed from the persisted conversation by
		// Manager.refreshContextUsage on run exit, and rides the idle
		// engine_status that handleRunExit emits immediately after this one.
		// translateToEngineEvent is pure and has no session access, so it
		// cannot resolve the real figure here.
		return types.EngineEvent{
			Type: "engine_status",
			Fields: &types.StatusFields{
				State:             "idle",
				SessionID:         e.SessionID,
				RunCostUsd:        e.CostUsd,
				CompletionReason:  e.Reason,
				ContextWindow:     contextWindow,
				PermissionDenials: e.PermissionDenials,
				NumTurns:          e.NumTurns,
				ConversationTurns: e.ConversationTurns,
			},
		}

	case *types.TaskSuspendEvent:
		// TaskSuspendEvent signals that a run ended without completing. Two
		// producers: a dispatched agent parked on child completions or a
		// revive message (AwaitingDispatchIDs), or a session parked at a turn
		// boundary because it still has background bash commands running
		// (AwaitingTaskIDs). Either way the run is not finished —
		// TaskCompleteEvent (and the normal idle engine_status) fires only
		// when it truly completes after revival. Clients may show a
		// parked/idle indicator meanwhile.
		return types.EngineEvent{
			Type:                         "engine_task_suspended",
			TaskSuspendAwaitingCount:     len(e.AwaitingDispatchIDs),
			TaskSuspendAwaitingTaskCount: len(e.AwaitingTaskIDs),
		}

	case *types.BackgroundTaskCompleteEvent:
		// A background bash command started with notify_on_complete reached a
		// terminal state. Emitted for every notifying command regardless of
		// whether the engine also delivers the result into a run.
		return types.EngineEvent{
			Type: "engine_background_task_complete",
			BackgroundTaskComplete: &types.BackgroundTaskCompletePayload{
				TaskID:           e.TaskID,
				Status:           e.Status,
				ExitCode:         e.ExitCode,
				ElapsedMs:        e.ElapsedMs,
				OutputPath:       e.OutputPath,
				Tail:             e.Tail,
				Command:          e.Command,
				RemainingTaskIDs: e.RemainingTaskIDs,
			},
		}

	case *types.DispatchLostEvent:
		// A dispatch that was running when the engine process died is
		// unrecoverable after restart. One event per orphan, emitted during
		// dispatch-state rehydration; the rehydrated agent-state row is
		// independently marked "error" so no panel shows it as running.
		return types.EngineEvent{
			Type: "engine_dispatch_lost",
			DispatchLost: &types.DispatchLostPayload{
				DispatchID:          e.DispatchID,
				AgentName:           e.AgentName,
				Task:                e.Task,
				ParentDispatchID:    e.ParentDispatchID,
				Depth:               e.Depth,
				ChildConversationID: e.ChildConversationID,
			},
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
			StderrTail:    e.StderrTail,
		}

	case *types.UsageEvent:
		// The per-turn UsageEvent is the authoritative context-occupancy
		// signal: backend.runloop sums input + cache_read + cache_creation
		// before emitting, so InputTokens here is what the model actually
		// carried. Percent is UNBOUNDED — above 100 means the conversation
		// exceeds the window it is measured against, which is real
		// information, not an error to be clamped away.
		var pct int
		if e.Usage.InputTokens != nil {
			window := contextWindow
			if window <= 0 {
				window = conversation.DefaultContext
			}
			pct = *e.Usage.InputTokens * 100 / window
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

	case *types.UserTurnPersistedEvent:
		return types.EngineEvent{
			Type:                        "engine_user_turn_persisted",
			UserTurnEntryID:             e.EntryID,
			UserTurnSlashModelAlias:     e.SlashModelAlias,
			UserTurnSlashModelEffective: e.SlashModelEffective,
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
		// Engine-initiated prompt (extension ctx.sendPrompt): the run's user
		// turn was not submitted by any consumer — the full text crosses the
		// wire so consumers can observe the injected turn. Kind classifies the
		// injection semantically; "agent_completion" marks a machine-to-machine
		// dispatch callback (a child agent's result routed to its parent) rather
		// than a user-authored turn. Consumers interpret Kind however they choose.
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

	case *types.CapabilityUnsupportedEvent:
		// Surface a declined feature request as a typed engine event so
		// clients can render a recoverable message (not a dead engine).
		// The engine reports; the harness decides (reroute / abort /
		// notify). See CLAUDE.md § "The typed-event corollary".
		return types.EngineEvent{
			Type:              "engine_capability_unsupported",
			Capability:        e.Capability,
			CapabilityBackend: e.Backend,
			CapabilityReason:  e.Reason,
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
				OccupancyTokens:     e.OccupancyTokens,
				AggregateCostUsd:    e.AggregateCostUsd,
				ModelBreakdown:      e.ModelBreakdown,
			},
		}

	default:
		return types.EngineEvent{}
	}
}
