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
	}
	for _, hook := range noOpHooks {
		h.registerNoOpForwarder(hook)
	}

	// String-returning hooks: parse result.value, return if non-empty.
	stringHooks := []string{
		HookInput, HookModelSelect, HookContext,
		HookPlanModePrompt, HookContextInject,
		HookCapabilityDiscover, HookCapabilityMatch, HookCapabilityInvoke,
		HookPermissionClassify,
	}
	for _, hook := range stringHooks {
		h.registerStringForwarder(hook)
	}

	// Dedicated forwarders for hooks with structured results.
	h.registerBeforeAgentStartForwarder()
	h.registerBeforePromptForwarder()

	// Block-checking hooks: parse result.block and result.reason.
	h.registerBlockForwarder(HookToolCall)

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

func min(a, b int) int {
	if a < b { return a }
	return b
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
// that parses {"systemPrompt": "string"} and returns a BeforeAgentStartResult.
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
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", HookBeforeAgentStart, err))
			return nil, nil
		}
		if result.SystemPrompt == "" {
			return nil, nil
		}
		return BeforeAgentStartResult{SystemPrompt: result.SystemPrompt}, nil
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
