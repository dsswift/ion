// hooks.go — hook names, typed descriptors, and the runtime registry.
//
// # Why descriptors
//
// A hook has two types: what the engine sends and what it will read back. In
// TypeScript only the first is modelled (HookPayloadMap keys the payload; the
// return is `unknown`). Here a Hook[P, R] descriptor carries both, so
// [OnHook] can decode the payload into P and marshal the handler's R without
// the author writing a single json call.
//
// The descriptors also make the SDK's hook coverage enumerable at runtime,
// which is what lets parity_test.go check this SDK against the engine's
// contract manifest instead of trusting a convention.
//
// # Why a free function instead of a method
//
// Go methods cannot have type parameters, so registration is
// OnHook(sdk, hook, handler) rather than sdk.OnHook(hook, handler).
package ion

import (
	"encoding/json"
	"reflect"
)

// Hook names. Byte-identical to the engine's constants in
// engine/internal/extension/sdk.go — the parity test asserts the whole set.
const (
	// Lifecycle.
	HookNameSessionStart = "session_start"
	HookNameSessionEnd   = "session_end"
	HookNameBeforePrompt = "before_prompt"
	HookNameTurnStart    = "turn_start"
	HookNameTurnEnd      = "turn_end"
	HookNameMessageStart = "message_start"
	HookNameMessageEnd   = "message_end"
	HookNameToolStart    = "tool_start"
	HookNameToolEnd      = "tool_end"
	HookNameToolCall     = "tool_call"
	HookNameOnError      = "on_error"
	HookNameAgentStart   = "agent_start"
	HookNameAgentEnd     = "agent_end"

	// Session management.
	HookNameSessionBeforeCompact  = "session_before_compact"
	HookNameSessionCompact        = "session_compact"
	HookNameSessionBeforeFork     = "session_before_fork"
	HookNameSessionFork           = "session_fork"
	HookNameSessionBeforeSwitch   = "session_before_switch"
	HookNameCompactSummaryRequest = "compact_summary_request"

	// Pre-action.
	HookNameBeforeAgentStart      = "before_agent_start"
	HookNameBeforeProviderRequest = "before_provider_request"

	// Early stop.
	HookNameBeforeEarlyStopDecision = "before_early_stop_decision"
	HookNameEarlyStopContinued      = "early_stop_continued"

	// Content.
	HookNameContext              = "context"
	HookNameMessageUpdate        = "message_update"
	HookNameToolResult           = "tool_result"
	HookNameInput                = "input"
	HookNameModelSelect          = "model_select"
	HookNameUserBash             = "user_bash"
	HookNameSlashCommandResolved = "slash_command_resolved"

	// Per-tool call.
	HookNameBashToolCall  = "bash_tool_call"
	HookNameReadToolCall  = "read_tool_call"
	HookNameWriteToolCall = "write_tool_call"
	HookNameEditToolCall  = "edit_tool_call"
	HookNameGrepToolCall  = "grep_tool_call"
	HookNameGlobToolCall  = "glob_tool_call"
	HookNameAgentToolCall = "agent_tool_call"

	// Per-tool result.
	HookNameBashToolResult  = "bash_tool_result"
	HookNameReadToolResult  = "read_tool_result"
	HookNameWriteToolResult = "write_tool_result"
	HookNameEditToolResult  = "edit_tool_result"
	HookNameGrepToolResult  = "grep_tool_result"
	HookNameGlobToolResult  = "glob_tool_result"
	HookNameAgentToolResult = "agent_tool_result"

	// Context discovery.
	HookNameContextDiscover = "context_discover"
	HookNameContextLoad     = "context_load"
	HookNameInstructionLoad = "instruction_load"

	// Permissions.
	HookNamePermissionRequest  = "permission_request"
	HookNamePermissionDenied   = "permission_denied"
	HookNamePermissionClassify = "permission_classify"

	// Files.
	HookNameFileChanged          = "file_changed"
	HookNameWorkspaceFileChanged = "workspace_file_changed"

	// Tasks.
	HookNameTaskCreated             = "task_created"
	HookNameTaskCompleted           = "task_completed"
	HookNameBackgroundTaskCompleted = "background_task_completed"

	// Dispatch loss.
	HookNameDispatchLost = "dispatch_lost"

	// Elicitation.
	HookNameElicitationRequest = "elicitation_request"
	HookNameElicitationResult  = "elicitation_result"

	// Plan mode.
	HookNamePlanModePrompt         = "plan_mode_prompt"
	HookNameBeforePlanModeEnter    = "before_plan_mode_enter"
	HookNameBeforePlanModeExit     = "before_plan_mode_exit"
	HookNameBeforePlanModeAutoExit = "before_plan_mode_auto_exit"
	HookNameSystemInject           = "system_inject"

	// Context injection.
	HookNameContextInject = "context_inject"

	// Capabilities.
	HookNameCapabilityDiscover = "capability_discover"
	HookNameCapabilityMatch    = "capability_match"
	HookNameCapabilityInvoke   = "capability_invoke"

	// Extension lifecycle.
	HookNameExtensionRespawned     = "extension_respawned"
	HookNameTurnAborted            = "turn_aborted"
	HookNamePeerExtensionDied      = "peer_extension_died"
	HookNamePeerExtensionRespawned = "peer_extension_respawned"

	// Async-trigger registration.
	HookNameWebhookRegistered    = "webhook_registered"
	HookNameWebhookDeregistered  = "webhook_deregistered"
	HookNameScheduleRegistered   = "schedule_registered"
	HookNameScheduleDeregistered = "schedule_deregistered"
	HookNameScheduleMissed       = "schedule_missed"

	// Cross-session messaging.
	HookNameSessionMessage = "session_message"
)

// Hook is a typed hook descriptor: P is the payload the engine sends, R the
// result it will read back. Pass one to [OnHook].
type Hook[P any, R any] struct {
	// Name is the wire hook name.
	Name string
}

// HookInfo is a registered hook's runtime metadata, used by the parity test to
// enumerate this SDK's coverage.
type HookInfo struct {
	// Name is the wire hook name.
	Name string
	// PayloadType is the handler's payload type. Nil for untyped
	// registrations made through [SDK.On].
	PayloadType reflect.Type
	// ResultType is the handler's result type. Nil for untyped registrations.
	ResultType reflect.Type
	// Untyped marks a registration made through [SDK.On] rather than
	// [OnHook].
	Untyped bool
}

// NoPayload marks a hook that fires with no payload.
type NoPayload struct{}

// NoResult marks a hook whose return value the engine discards.
type NoResult struct{}

// StringResult is the result type for hooks whose handler returns a string
// that replaces an engine-computed value. Returning the empty string abstains.
type StringResult string

// BoolResult is the result type for the cancellable hooks: false cancels the
// pending operation.
type BoolResult bool

// OnHook registers a typed hook handler.
//
// The payload arrives decoded into P, and the handler's R is marshalled into
// the response. Returning the zero R abstains, matching the engine's
// last-writer-wins merge across handlers.
//
//	ion.OnHook(sdk, ion.HookBeforePrompt, func(ctx *ion.Context, prompt string) (ion.BeforePromptResult, error) {
//		return ion.BeforePromptResult{Prompt: prompt + "\n\n(reviewed)"}, nil
//	})
//
// A second registration for the same hook replaces the first.
func OnHook[P any, R any](s *SDK, hook Hook[P, R], fn func(ctx *Context, payload P) (R, error)) {
	var zeroP P
	var zeroR R

	wrapped := func(ctx *Context, raw json.RawMessage) (any, error) {
		payload := zeroP
		if len(raw) > 0 && string(raw) != "null" {
			if err := json.Unmarshal(raw, &payload); err != nil {
				// Decoding failure is a real contract mismatch — the engine
				// sent a shape this SDK version does not model. Surface it
				// rather than invoking the handler with a zero payload,
				// which would look like a legitimate empty firing.
				return nil, &payloadDecodeError{Hook: hook.Name, Err: err}
			}
		}
		result, err := fn(ctx, payload)
		if err != nil {
			return nil, err
		}
		if isZeroResult(result, zeroR) {
			// Abstain: a nil result tells the engine this handler has no
			// opinion, which is distinct from returning an empty struct.
			return nil, nil
		}
		return result, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.hooks[hook.Name] = hookEntry{
		handler: wrapped,
		info: HookInfo{
			Name:        hook.Name,
			PayloadType: reflect.TypeOf(zeroP),
			ResultType:  reflect.TypeOf(zeroR),
		},
	}
}

// isZeroResult reports whether a handler returned the zero value, which the
// SDK translates to "no opinion". Compared through reflection because R is
// not constrained to be comparable.
func isZeroResult(result, zero any) bool {
	rv := reflect.ValueOf(result)
	if !rv.IsValid() {
		return true
	}
	if rv.Kind() == reflect.Ptr || rv.Kind() == reflect.Interface ||
		rv.Kind() == reflect.Map || rv.Kind() == reflect.Slice {
		return rv.IsNil()
	}
	return reflect.DeepEqual(result, zero)
}

// payloadDecodeError reports a hook payload the SDK could not decode into the
// handler's declared type — an engine/SDK version mismatch, not a handler bug.
type payloadDecodeError struct {
	Hook string
	Err  error
}

func (e *payloadDecodeError) Error() string {
	return "ion: cannot decode payload for hook " + e.Hook + ": " + e.Err.Error()
}

func (e *payloadDecodeError) Unwrap() error { return e.Err }
