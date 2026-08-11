// host_rpc_session.go — session-scoped ext/* handlers: prompting, tool calls,
// context/usage queries, history search, and sandbox wrapping.
//
// Extracted verbatim from the handleExtRequest switch when that switch became
// the declared registry in host_rpc_registry.go. Behaviour is unchanged.

package extension

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/sandbox"
	"github.com/dsswift/ion/engine/internal/utils"
)

func (h *Host) rpcSendPrompt(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params struct {
			Text                   string   `json:"text"`
			Model                  string   `json:"model,omitempty"`
			BashAllowlistAdditions []string `json:"bashAllowlistAdditions,omitempty"`
			Kind                   string   `json:"kind,omitempty"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	if req.Params.Text == "" {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "prompt text required"})
		return
	}
	if ctx != nil && ctx.SendPrompt != nil {
		// Active hook context: use hook-aware path (supports model override,
		// per-prompt bash-allowlist additions, recursion guard). When Kind is
		// set, use SendPromptPayload (if wired) so Kind reaches emitPromptInjected;
		// fall back to SendPrompt for callers that have not wired the payload variant.
		utils.LogWithFields(utils.LevelDebug, "extension", "ext/send_prompt: hook ctx path", map[string]any{"model": req.Params.Model, "count": len(req.Params.BashAllowlistAdditions), "kind": req.Params.Kind})
		go func() {
			var err error
			if req.Params.Kind != "" && ctx.SendPromptPayload != nil {
				err = ctx.SendPromptPayload(SendPromptPayload{
					Text:                   req.Params.Text,
					Model:                  req.Params.Model,
					BashAllowlistAdditions: req.Params.BashAllowlistAdditions,
					Kind:                   req.Params.Kind,
				})
			} else {
				err = ctx.SendPrompt(req.Params.Text, req.Params.Model, req.Params.BashAllowlistAdditions)
			}
			if err != nil {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
				return
			}
			h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
		}()
		return
	}
	// No active hook context (e.g. called from a timer/scheduler): fall back to
	// the session-level SendPrompt wired by the session manager via onSendMessage.
	// The fallback path now carries the FULL payload (model override +
	// bash-allowlist additions + kind), identical to the active-hook path above —
	// onSendMessage takes a SendPromptPayload, and both session wiring sites
	// build PromptOverrides from it via the shared buildPromptOverrides helper.
	// There is no per-feature divergence between the two dispatch paths.
	h.notifMu.RLock()
	fn := h.onSendMessage
	h.notifMu.RUnlock()
	if fn == nil {
		utils.Debug("extension", "ext/send_prompt: no hook ctx and no onSendMessage; rejecting")
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "sendPrompt not available: no active session"})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "extension", "ext/send_prompt: fallback path via onsendmessage forwarding full payload", map[string]any{"model": req.Params.Model, "count": len(req.Params.BashAllowlistAdditions), "kind": req.Params.Kind})
	go func() {
		fn(SendPromptPayload{
			Text:                   req.Params.Text,
			Model:                  req.Params.Model,
			BashAllowlistAdditions: req.Params.BashAllowlistAdditions,
			Kind:                   req.Params.Kind,
		})
		h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
	}()
}

func (h *Host) rpcCallTool(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params struct {
			Name    string                 `json:"name"`
			Input   map[string]interface{} `json:"input"`
			Timeout *float64               `json:"timeout,omitempty"` // optional ms
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	if req.Params.Name == "" {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "tool name required"})
		return
	}
	if ctx == nil || ctx.CallToolWithContext == nil {
		// Fall back to legacy CallTool if the new API isn't wired.
		if ctx == nil || ctx.CallTool == nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "callTool not available outside an active session"})
			return
		}
		go func() {
			content, isError, err := ctx.CallTool(req.Params.Name, req.Params.Input)
			if err != nil {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
				return
			}
			data, _ := json.Marshal(struct { //nolint:errcheck // marshal of a local RPC struct
				Content string `json:"content"`
				IsError bool   `json:"isError,omitempty"`
			}{Content: content, IsError: isError})
			h.sendResponse(id, json.RawMessage(data), nil)
		}()
		return
	}
	go func() {
		content, isError, err := ctx.CallToolWithContext(req.Params.Name, req.Params.Input, req.Params.Timeout)
		if err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
			return
		}
		data, _ := json.Marshal(struct { //nolint:errcheck // marshal of a local RPC struct
			Content string `json:"content"`
			IsError bool   `json:"isError,omitempty"`
		}{Content: content, IsError: isError})
		h.sendResponse(id, json.RawMessage(data), nil)
	}()
}

func (h *Host) rpcGetContextUsage(ctx *Context, id int64, _ []byte) {
	// Read-only query: return the active run's context usage snapshot,
	// or null when no run is active / the getter is unwired (extensions
	// loaded outside a session see null and can branch on it).
	if ctx == nil || ctx.GetContextUsage == nil {
		utils.Debug("extension", "ext/get_context_usage: no ctx or no getter, returning null")
		h.sendResponse(id, json.RawMessage(`null`), nil)
		return
	}
	usage := ctx.GetContextUsage()
	if usage == nil {
		utils.Debug("extension", "ext/get_context_usage: getter returned nil, responding null")
		h.sendResponse(id, json.RawMessage(`null`), nil)
		return
	}
	// Marshal with explicit JSON tags so the wire shape stays stable
	// independent of the in-package struct layout.
	data, err := json.Marshal(struct {
		Percent int     `json:"percent"`
		Tokens  int     `json:"tokens"`
		Cost    float64 `json:"cost"`
	}{Percent: usage.Percent, Tokens: usage.Tokens, Cost: usage.Cost})
	if err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/get_context_usage: marshal failed", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	utils.LogWithFields(utils.LevelDebug, "extension", "ext/get_context_usage: returning", map[string]any{"percent": usage.Percent, "tokens": usage.Tokens, "cost": usage.Cost})
	h.sendResponse(id, json.RawMessage(data), nil)
}

func (h *Host) rpcListDispatchState(ctx *Context, id int64, _ []byte) {
	// Read-only query: return every active dispatch in the session's
	// DispatchRegistry as a { dispatches: [...] } envelope. Returns an
	// empty array (not null) when no dispatches are active or when the
	// getter is not wired (extensions loaded outside a dispatch-capable
	// session see an empty result and can branch on it safely).
	if ctx == nil || ctx.ListDispatchState == nil {
		utils.Debug("extension", "ext/list_dispatch_state: no ctx or no getter, returning empty array")
		h.sendResponse(id, json.RawMessage(`{"dispatches":[]}`), nil)
		return
	}
	entries, err := ctx.ListDispatchState()
	if err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/list_dispatch_state: getter returned error", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	if entries == nil {
		entries = []DispatchStateEntry{}
	}
	data, err := json.Marshal(struct {
		Dispatches []DispatchStateEntry `json:"dispatches"`
	}{Dispatches: entries})
	if err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/list_dispatch_state: marshal failed", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	utils.LogWithFields(utils.LevelDebug, "extension", "ext/list_dispatch_state: returning", map[string]any{"count": len(entries)})
	h.sendResponse(id, json.RawMessage(data), nil)
}

func (h *Host) rpcSearchHistory(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params struct {
			Query      string `json:"query"`
			MaxResults int    `json:"maxResults,omitempty"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/search_history: parse error", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	// Empty array (not null) when no active conversation / unwired -- TS
	// callers can iterate safely without null-guarding.
	if ctx == nil || ctx.SearchHistory == nil {
		utils.LogWithFields(utils.LevelDebug, "extension", "ext/search_history: no ctx or no searcher ( ), returning []", map[string]any{"query": req.Params.Query, "max_results": req.Params.MaxResults})
		h.sendResponse(id, json.RawMessage(`[]`), nil)
		return
	}
	matches, err := ctx.SearchHistory(req.Params.Query, req.Params.MaxResults)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/search_history: searcher returned error", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	if matches == nil {
		matches = []HistoryMatch{}
	}
	data, err := json.Marshal(matches)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/search_history: marshal failed", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	utils.LogWithFields(utils.LevelDebug, "extension", "ext/search_history: returning matches ( )", map[string]any{"count": len(matches), "query": req.Params.Query, "max_results": req.Params.MaxResults})
	h.sendResponse(id, json.RawMessage(data), nil)
}

func (h *Host) rpcSandboxWrap(_ *Context, id int64, raw []byte) {
	var req struct {
		Params struct {
			Command           string                     `json:"command"`
			Platform          string                     `json:"platform,omitempty"`
			FSAllowWrite      []string                   `json:"fsAllowWrite,omitempty"`
			FSDenyWrite       []string                   `json:"fsDenyWrite,omitempty"`
			FSDenyRead        []string                   `json:"fsDenyRead,omitempty"`
			NetAllowedDomains []string                   `json:"netAllowedDomains,omitempty"`
			NetBlockedDomains []string                   `json:"netBlockedDomains,omitempty"`
			NetAllowLocalBind bool                       `json:"netAllowLocalBind,omitempty"`
			ExtraPatterns     []sandbox.DangerousPattern `json:"extraPatterns,omitempty"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	cfg := sandbox.Config{
		Filesystem: sandbox.FSConfig{
			AllowWrite: req.Params.FSAllowWrite,
			DenyWrite:  req.Params.FSDenyWrite,
			DenyRead:   req.Params.FSDenyRead,
		},
		Network: sandbox.NetConfig{
			AllowedDomains: req.Params.NetAllowedDomains,
			BlockedDomains: req.Params.NetBlockedDomains,
			AllowLocalBind: req.Params.NetAllowLocalBind,
		},
		Patterns: req.Params.ExtraPatterns,
	}
	wrapped, err := sandbox.WrapCommand(req.Params.Command, cfg, req.Params.Platform)
	if err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	data, _ := json.Marshal(struct { //nolint:errcheck // marshal of a local RPC struct
		Wrapped  string `json:"wrapped"`
		Platform string `json:"platform"`
	}{Wrapped: wrapped, Platform: func() string {
		if req.Params.Platform != "" {
			return req.Params.Platform
		}
		return sandbox.DetectPlatform()
	}()})
	h.sendResponse(id, json.RawMessage(data), nil)
}
