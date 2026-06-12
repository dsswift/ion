package extension

import (
	"encoding/json"
	"fmt"

	"github.com/dsswift/ion/engine/internal/utils"
)



// the subprocess via JSON-RPC. Grouped by return-type semantics.
func (h *Host) registerHookForwarders() {
	// No-op hooks: fire and forget, ignore result.
	noOpHooks := []string{
		HookSessionStart, HookSessionEnd,
		HookTurnStart, HookTurnEnd,
		HookMessageStart, HookMessageEnd,
		HookToolStart, HookToolEnd,
		HookAgentStart, HookAgentEnd,
		HookSessionCompact, HookSessionFork, HookSessionBeforeSwitch,
		HookPermissionRequest, HookPermissionDenied,
		HookFileChanged,
		HookTaskCreated, HookTaskCompleted,
		HookElicitationResult,
		HookOnError,
		HookBeforeProviderRequest,
		HookUserBash,
		// Per-tool result hooks (no-op category -- fire to subprocess, ignore result)
		HookBashToolResult, HookReadToolResult, HookWriteToolResult,
		HookEditToolResult, HookGrepToolResult, HookGlobToolResult,
		HookAgentToolResult,
		// Extension lifecycle hooks (observational; engine fires after auto-respawn).
		HookExtensionRespawned, HookTurnAborted,
		HookPeerExtensionDied, HookPeerExtensionRespawned,
		// Async-trigger deregistration hooks (observation-only;
		// veto would let one extension trap another's resources).
		HookWebhookDeregistered, HookScheduleDeregistered,
		// Cross-session messaging: forward the session_message hook
		// to the subprocess so ion.on('session_message', ...) fires.
		HookSessionMessage,
	}
	for _, hook := range noOpHooks {
		h.registerNoOpForwarder(hook)
	}

	// String-returning hooks: parse result.value, return if non-empty.
	stringHooks := []string{
		HookInput, HookModelSelect, HookContext,
		HookPlanModePrompt, HookSystemInject, HookContextInject,
		HookCapabilityDiscover, HookCapabilityMatch, HookCapabilityInvoke,
		HookPermissionClassify,
	}
	for _, hook := range stringHooks {
		h.registerStringForwarder(hook)
	}

	// Dedicated forwarders for hooks with structured results.
	h.registerBeforeAgentStartForwarder()
	h.registerBeforePromptForwarder()
	h.registerBeforePlanModeEnterForwarder()
	h.registerBeforePlanModeExitForwarder()
	h.registerBeforePlanModeAutoExitForwarder()

	// Block-checking hooks: parse result.block and result.reason.
	h.registerBlockForwarder(HookToolCall)

	// Async-trigger registration veto hooks: same {block, reason}
	// shape as registerBlockForwarder but the return type is
	// *AsyncRegistrationVeto so the FireXxx wrappers can decode it.
	h.registerAsyncRegistrationVetoForwarder(HookWebhookRegistered)
	h.registerAsyncRegistrationVetoForwarder(HookScheduleRegistered)

	// Per-tool call hooks: parse result.block, result.reason, result.mutate.
	perToolCallHooks := []string{
		HookBashToolCall, HookReadToolCall, HookWriteToolCall,
		HookEditToolCall, HookGrepToolCall, HookGlobToolCall,
		HookAgentToolCall,
	}
	for _, hook := range perToolCallHooks {
		h.registerPerToolCallForwarder(hook)
	}

	// Boolean canceller hooks: parse result as bool.
	boolHooks := []string{
		HookSessionBeforeCompact, HookSessionBeforeFork, HookContextDiscover,
	}
	for _, hook := range boolHooks {
		h.registerBoolForwarder(hook)
	}

	// Rejection hooks: parse result.content and result.reject.
	rejectionHooks := []string{
		HookContextLoad, HookInstructionLoad,
	}
	for _, hook := range rejectionHooks {
		h.registerRejectionForwarder(hook)
	}

	// Content hooks: forward and return raw result.
	contentHooks := []string{
		HookMessageUpdate, HookToolResult, HookElicitationRequest,
	}
	for _, hook := range contentHooks {
		h.registerContentForwarder(hook)
	}
}

// emitHookError surfaces a hook failure to the client via engine_error event.
// registerNoOpForwarder registers a handler that forwards the hook to the
// subprocess and ignores any result.
func (h *Host) registerNoOpForwarder(hook string) {
	h.sdk.On(hook, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+hook, ctx, payload)
		if err != nil {
			logHookErr(hook, err)
				var stack string
				if he, ok := err.(*hookError); ok {
					stack = he.Stack
				}
				emitHookError(ctx, hook, err, stack)
		}
		if len(raw) > 0 {
			n := len(raw); if n > 2000 { n = 2000 }
				utils.Log("extension", fmt.Sprintf("hook/%s raw response: %s", hook, string(raw[:n])))
		}
		emitHookEvents(ctx, raw)
		return nil, nil
	})
}

// registerStringForwarder registers a handler that forwards the hook and
// returns the subprocess's result as a string. Accepts both the wrapped
// `{"value": "..."}` shape (used when the handler also emits events) and
// a bare JSON string return — the SDK only wraps when events accumulate.
func (h *Host) registerStringForwarder(hook string) {
	h.sdk.On(hook, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+hook, ctx, payload)
		if err != nil {
			logHookErr(hook, err)
			var stack string
			if he, ok := err.(*hookError); ok {
				stack = he.Stack
			}
			emitHookError(ctx, hook, err, stack)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		// Try {value: "..."} first (handlers that also emit events).
		var wrapped struct {
			Value string `json:"value"`
		}
		if err := json.Unmarshal(raw, &wrapped); err == nil && wrapped.Value != "" {
			return wrapped.Value, nil
		}
		// Fall back to a bare JSON string — the SDK ships the handler's
		// return value as-is when no events accumulated.
		var bare string
		if err := json.Unmarshal(raw, &bare); err == nil && bare != "" {
			return bare, nil
		}
		return nil, nil
	})
}

// registerBeforeAgentStartForwarder registers a handler for before_agent_start
// that parses {"systemPrompt": "string", "agentName": "string"} and returns
// a BeforeAgentStartResult.
func (h *Host) registerBeforeAgentStartForwarder() {
	h.sdk.On(HookBeforeAgentStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+HookBeforeAgentStart, ctx, payload)
		if err != nil {
			logHookErr(HookBeforeAgentStart, err)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result struct {
			SystemPrompt string `json:"systemPrompt"`
			AgentName    string `json:"agentName"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", HookBeforeAgentStart, err))
			return nil, nil
		}
		if result.SystemPrompt == "" && result.AgentName == "" {
			return nil, nil
		}
		return BeforeAgentStartResult{
			SystemPrompt: result.SystemPrompt,
			AgentName:    result.AgentName,
		}, nil
	})
}

// registerBeforePromptForwarder registers a handler for before_prompt that
// parses {"prompt": "string", "systemPrompt": "string", "value": "string"}.
// Supports all extension return shapes:
//   - {"value": "rewritten"}          -> plain string (backward compat)
//   - {"systemPrompt": "..."}         -> BeforePromptResult
//   - {"prompt": "...", "systemPrompt": "..."} -> BeforePromptResult with both
func (h *Host) registerBeforePromptForwarder() {
	h.sdk.On(HookBeforePrompt, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+HookBeforePrompt, ctx, payload)
		if err != nil {
			logHookErr(HookBeforePrompt, err)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result struct {
			Value        string `json:"value"`
			Prompt       string `json:"prompt"`
			SystemPrompt string `json:"systemPrompt"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", HookBeforePrompt, err))
			return nil, nil
		}
		// If systemPrompt is set, return structured result
		if result.SystemPrompt != "" || result.Prompt != "" {
			return BeforePromptResult{
				Prompt:       result.Prompt,
				SystemPrompt: result.SystemPrompt,
			}, nil
		}
		// Backward compat: plain string via value field
		if result.Value != "" {
			return result.Value, nil
		}
		return nil, nil
	})
}

// registerBlockForwarder registers a handler for tool_call that parses
// {"block": bool, "reason": "string"} and returns a *ToolCallResult.
func (h *Host) registerBlockForwarder(hook string) {
	h.sdk.On(hook, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+hook, ctx, payload)
		if err != nil {
			logHookErr(hook, err)
				var stack string
				if he, ok := err.(*hookError); ok {
					stack = he.Stack
				}
				emitHookError(ctx, hook, err, stack)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result struct {
			Block  bool   `json:"block"`
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", hook, err))
			return nil, nil
		}
		if !result.Block {
			return nil, nil
		}
		return &ToolCallResult{
			Block:  true,
			Reason: result.Reason,
		}, nil
	})
}

// registerPerToolCallForwarder registers a handler for per-tool call hooks
// that parses {"block": bool, "reason": "string", "mutate": {...}}.
func (h *Host) registerPerToolCallForwarder(hook string) {
	h.sdk.On(hook, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+hook, ctx, payload)
		if err != nil {
			logHookErr(hook, err)
				var stack string
				if he, ok := err.(*hookError); ok {
					stack = he.Stack
				}
				emitHookError(ctx, hook, err, stack)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result struct {
			Block  bool                   `json:"block"`
			Reason string                 `json:"reason"`
			Mutate map[string]interface{} `json:"mutate"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", hook, err))
			return nil, nil
		}
		if !result.Block && result.Mutate == nil {
			return nil, nil
		}
		return &PerToolCallResult{
			Block:  result.Block,
			Reason: result.Reason,
			Mutate: result.Mutate,
		}, nil
	})
}

// registerBoolForwarder registers a handler that parses the result as a bool.
// Returns true to cancel the operation.
func (h *Host) registerBoolForwarder(hook string) {
	h.sdk.On(hook, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+hook, ctx, payload)
		if err != nil {
			logHookErr(hook, err)
				var stack string
				if he, ok := err.(*hookError); ok {
					stack = he.Stack
				}
				emitHookError(ctx, hook, err, stack)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var cancel bool
		if err := json.Unmarshal(raw, &cancel); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", hook, err))
			return nil, nil
		}
		if !cancel {
			return nil, nil
		}
		return true, nil
	})
}

// registerRejectionForwarder registers a handler for context_load and
// instruction_load that parses {"content": "string", "reject": bool}.
func (h *Host) registerRejectionForwarder(hook string) {
	h.sdk.On(hook, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+hook, ctx, payload)
		if err != nil {
			logHookErr(hook, err)
				var stack string
				if he, ok := err.(*hookError); ok {
					stack = he.Stack
				}
				emitHookError(ctx, hook, err, stack)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result struct {
			Content string `json:"content"`
			Reject  bool   `json:"reject"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", hook, err))
			return nil, nil
		}
		if result.Reject {
			return true, nil
		}
		if result.Content != "" {
			return result.Content, nil
		}
		return nil, nil
	})
}

// registerContentForwarder registers a handler that forwards the hook and
// returns the raw result as a map for content-type hooks.
func (h *Host) registerContentForwarder(hook string) {
	h.sdk.On(hook, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+hook, ctx, payload)
		if err != nil {
			logHookErr(hook, err)
				var stack string
				if he, ok := err.(*hookError); ok {
					stack = he.Stack
				}
				emitHookError(ctx, hook, err, stack)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result map[string]interface{}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", hook, err))
			return nil, nil
		}
		return result, nil
	})
}

// registerBeforePlanModeEnterForwarder registers a handler for
// before_plan_mode_enter that parses {"allow": bool, "reason": "string"}.
// Nil Allow (field absent or null) means "no opinion; use default (allow)".
func (h *Host) registerBeforePlanModeEnterForwarder() {
	h.sdk.On(HookBeforePlanModeEnter, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+HookBeforePlanModeEnter, ctx, payload)
		if err != nil {
			logHookErr(HookBeforePlanModeEnter, err)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result struct {
			Allow  *bool  `json:"allow"`
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", HookBeforePlanModeEnter, err))
			return nil, nil
		}
		if result.Allow == nil {
			return nil, nil
		}
		return &BeforePlanModeEnterResult{Allow: result.Allow, Reason: result.Reason}, nil
	})
}

// registerBeforePlanModeExitForwarder registers a handler for
// before_plan_mode_exit that parses {"allow": bool, "reason": "string"}.
// Nil Allow (field absent or null) means "no opinion; use default (allow)".
func (h *Host) registerBeforePlanModeExitForwarder() {
	h.sdk.On(HookBeforePlanModeExit, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+HookBeforePlanModeExit, ctx, payload)
		if err != nil {
			logHookErr(HookBeforePlanModeExit, err)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result struct {
			Allow  *bool  `json:"allow"`
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", HookBeforePlanModeExit, err))
			return nil, nil
		}
		if result.Allow == nil {
			return nil, nil
		}
		return &BeforePlanModeExitResult{Allow: result.Allow, Reason: result.Reason}, nil
	})
}

// registerBeforePlanModeAutoExitForwarder registers a handler for
// before_plan_mode_auto_exit that parses
// {"suppress": bool, "planFilePath": "string", "reason": "string"}.
//
// All fields are optional. An entirely empty / null result means "no
// opinion; proceed with synthesis using engine defaults." A handler
// that only sets one field leaves the others untouched — the SDK fire
// method (FireBeforePlanModeAutoExit) resolves multi-handler conflicts
// per-field via last-writer-wins.
func (h *Host) registerBeforePlanModeAutoExitForwarder() {
	h.sdk.On(HookBeforePlanModeAutoExit, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+HookBeforePlanModeAutoExit, ctx, payload)
		if err != nil {
			logHookErr(HookBeforePlanModeAutoExit, err)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result struct {
			Suppress     bool   `json:"suppress"`
			PlanFilePath string `json:"planFilePath"`
			Reason       string `json:"reason"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", HookBeforePlanModeAutoExit, err))
			return nil, nil
		}
		// Skip returning a result when every field is zero — saves the
		// SDK fire method an iteration of "is anything set?" work and
		// keeps the no-opinion fast path symmetric with the other
		// plan-mode forwarders above.
		if !result.Suppress && result.PlanFilePath == "" && result.Reason == "" {
			return nil, nil
		}
		return &BeforePlanModeAutoExitResult{
			Suppress:     result.Suppress,
			PlanFilePath: result.PlanFilePath,
			Reason:       result.Reason,
		}, nil
	})
}
