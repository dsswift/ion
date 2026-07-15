package extension

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/sandbox"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)


// --- Extension notifications ---

// handleExtNotification processes extension-initiated JSON-RPC notifications
// (messages with a method field but no pending response ID). These allow
// extensions to emit events and queue messages back to the engine.
func (h *Host) handleExtNotification(method string, raw []byte) {
	switch method {
	case "ext/emit":
		var notif struct {
			Params types.EngineEvent `json:"params"`
		}
		if err := json.Unmarshal(raw, &notif); err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension", "ext/emit parse error", map[string]any{"error": err})
			return
		}
		// Resolve emit function: prefer active context, fall back to persistent emit
		var emitFn func(types.EngineEvent)
		if ctx := h.ctxStack.Current(); ctx != nil && ctx.Emit != nil {
			emitFn = ctx.Emit
		} else {
			h.notifMu.RLock()
			emitFn = h.persistentEmit
			h.notifMu.RUnlock()
		}
		if emitFn == nil {
			return
		}
		// Validate engine_agent_state payloads before forwarding
		if notif.Params.Type == "engine_agent_state" {
			var warnings []string
			for i, agent := range notif.Params.Agents {
				if agent.Name == "" {
					warnings = append(warnings, fmt.Sprintf("agent[%d]: missing name", i))
				}
				if md := agent.Metadata; md != nil {
					if dn, ok := md["displayName"]; !ok || dn == nil || dn == "" {
						warnings = append(warnings, fmt.Sprintf("agent[%d] (%s): missing displayName in metadata", i, agent.Name))
					}
				}
			}
			if len(warnings) > 0 {
				msg := fmt.Sprintf("extension emitted malformed engine_agent_state: %s", strings.Join(warnings, "; "))
				utils.Warn("extension", msg)
				emitFn(types.EngineEvent{
					Type:         "engine_error",
					EventMessage: msg,
					ErrorCode:    "malformed_agent_state",
				})
			}
		}
		emitFn(notif.Params)
	case "ext/send_message":
		var notif struct {
			Params struct {
				Text string `json:"text"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &notif); err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension", "ext/send_message parse error", map[string]any{"error": err})
			return
		}
		h.notifMu.RLock()
		fn := h.onSendMessage
		h.notifMu.RUnlock()
		if fn != nil && notif.Params.Text != "" {
			// The ext/send_message notification shape carries text only (no
			// model / bash-allowlist fields), so the payload is text-only here.
			// Extensions that need per-prompt model or bash grants use the
			// ext/send_prompt request, which carries the full payload below.
			fn(SendPromptPayload{Text: notif.Params.Text})
		}
	case "log":
		// Native SDK logging channel. Routes structured log calls (and
		// redirected console.* output) through the JSON-RPC frame so
		// nothing ever lands on the subprocess's raw stdout. Structured
		// fields are preserved as the canonical `fields` object — never
		// concatenated into the message string.
		var notif struct {
			Params struct {
				Level   string         `json:"level"`
				Message string         `json:"message"`
				Fields  map[string]any `json:"fields,omitempty"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &notif); err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension", "log notif parse error", map[string]any{"error": err})
			return
		}

		// Per the log schema, extension-component logs carry the extension
		// name as their tag.
		tag := h.name
		if tag == "" {
			tag = "ext"
		}

		// Resolve session/conversation IDs from the host's bound session
		// context so extension logs correlate with the engine session.
		sessionID, conversationID := h.getBoundIDs()

		fields := notif.Params.Fields
		if fields == nil {
			fields = map[string]any{}
		}

		lvl := utils.ParseLevel(notif.Params.Level)
		// LogExtension stamps component="extension" and the bound IDs, and
		// preserves fields verbatim.
		utils.LogExtension(lvl, tag, notif.Params.Message, fields, sessionID, conversationID)
	case "ext/llm_call_cancel":
		// Per-call cancellation for ctx.llmCall({ signal }). The TS runtime
		// fires this fire-and-forget notification (no response) when the
		// caller's AbortSignal aborts, keyed by the in-flight ext/llm_call
		// RPC id. We look up the registered CancelFunc and invoke it; an
		// unknown id is a benign race with completion (logged, no-op).
		var notif struct {
			Params struct {
				RequestID int64 `json:"requestId"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &notif); err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension", "ext/llm_call_cancel parse error", map[string]any{"error": err})
			return
		}
		cancelled := h.cancelInflightLLMCall(notif.Params.RequestID)
		utils.LogWithFields(utils.LevelDebug, "extension", "ext/llm_call_cancel", map[string]any{"run_id": notif.Params.RequestID, "cancelled": cancelled})
	default:
		utils.LogWithFields(utils.LevelInfo, "extension", "unknown notification method", map[string]any{"method": method})
	}
}

// handleExtRequest processes extension-initiated JSON-RPC requests (messages
// with both a method and id field). The engine sends a response back.
func (h *Host) handleExtRequest(method string, id int64, raw []byte) {
	ctx := h.ctxStack.Current()
	// Async-trigger registration RPCs live in host_rpc_async.go to keep
	// this file under the 800-line cap. handleAsyncRPC returns true when
	// it dispatched the method.
	if h.handleAsyncRPC(method, id, raw) {
		return
	}
	// runOnce dedup RPCs live in host_rpc_run_once.go.
	if h.handleRunOnceRPC(method, id, raw) {
		return
	}
	// Steer RPCs (ext/steer_dispatch, ext/steer_self) live in
	// host_rpc_steer.go to keep this file under the 800-line cap.
	if h.handleSteerRPC(ctx, method, id, raw) {
		return
	}
	// Pre-authenticated outbound HTTP (ext/http_request) lives in
	// host_rpc_http.go. Session-independent: works outside active sessions.
	if h.handleHTTPRPC(method, id, raw) {
		return
	}
	switch method {
	case "ext/register_process":
		var req struct {
			Params struct {
				Name string `json:"name"`
				PID  int    `json:"pid"`
				Task string `json:"task"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "invalid params: " + err.Error()})
			return
		}
		if ctx != nil && ctx.RegisterProcess != nil {
			if err := ctx.RegisterProcess(req.Params.Name, req.Params.PID, req.Params.Task); err != nil {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
				return
			}
		}
		h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)

	case "ext/deregister_process":
		var req struct {
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "invalid params: " + err.Error()})
			return
		}
		if ctx != nil && ctx.DeregisterProcess != nil {
			ctx.DeregisterProcess(req.Params.Name)
		}
		h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)

	case "ext/list_processes":
		var procs []ProcessInfo
		if ctx != nil && ctx.ListProcesses != nil {
			procs = ctx.ListProcesses()
		}
		if procs == nil {
			procs = []ProcessInfo{}
		}
		data, _ := json.Marshal(procs)
		h.sendResponse(id, data, nil)

	case "ext/terminate_process":
		var req struct {
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "invalid params: " + err.Error()})
			return
		}
		if ctx != nil && ctx.TerminateProcess != nil {
			if err := ctx.TerminateProcess(req.Params.Name); err != nil {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
				return
			}
		}
		h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)

	case "ext/clean_stale_processes":
		var count int
		if ctx != nil && ctx.CleanStaleProcesses != nil {
			count = ctx.CleanStaleProcesses()
		}
		data, _ := json.Marshal(map[string]int{"cleaned": count})
		h.sendResponse(id, data, nil)

	case "ext/discover_agents":
		var req struct {
			Params DiscoverAgentsOpts `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return
		}
		if ctx != nil && ctx.DiscoverAgents != nil {
			result, err := ctx.DiscoverAgents(req.Params)
			if err != nil {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
				return
			}
			data, _ := json.Marshal(result)
			h.sendResponse(id, json.RawMessage(data), nil)
		} else {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "agent discovery not available"})
		}

	case "ext/suppress_tool":
		var req struct {
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "invalid params: " + err.Error()})
			return
		}
		if ctx != nil && ctx.SuppressTool != nil {
			ctx.SuppressTool(req.Params.Name)
		}
		h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)

	case "ext/set_dispatch_context_defaults":
		h.handleSetDispatchContextDefaults(id, raw)

	case "ext/walk_context_files":
		h.handleWalkContextFiles(id, raw)

	case "ext/dispatch_agent":
		var req struct {
			Params DispatchAgentOpts `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return
		}
		if ctx != nil && ctx.DispatchAgent != nil {
			// Wire raw event forwarding.
			req.Params.OnEvent = func(ev types.EngineEvent) {
				evData, err := json.Marshal(ev)
				if err == nil {
					h.sendNotification("dispatch_event", evData)
				}
			}

			if req.Params.Background {
				// Background dispatch: wire completion callbacks to send
				// JSON-RPC notifications, respond immediately with a stub.
				agentName := req.Params.Name
				req.Params.OnComplete = func(result DispatchAgentResult) {
					result.Name = agentName
					data, _ := json.Marshal(result)
					h.sendNotification("dispatch_complete", data)
				}
				req.Params.OnError = func(err DispatchError) {
					err.Name = agentName
					data, _ := json.Marshal(err)
					h.sendNotification("dispatch_error", data)
				}
				req.Params.OnRecall = func(info RecallInfo) {
					info.Name = agentName
					data, _ := json.Marshal(info)
					h.sendNotification("dispatch_recall", data)
				}

				// Wire lifecycle callbacks to notifications.
				req.Params.OnToolStart = func(info DispatchToolStartInfo) {
					info.Name = agentName
					data, _ := json.Marshal(info)
					h.sendNotification("dispatch_tool_start", data)
				}
				req.Params.OnToolEnd = func(info DispatchToolEndInfo) {
					info.Name = agentName
					data, _ := json.Marshal(info)
					h.sendNotification("dispatch_tool_end", data)
				}
				req.Params.OnToolError = func(info DispatchToolErrorInfo) {
					info.Name = agentName
					data, _ := json.Marshal(info)
					h.sendNotification("dispatch_tool_error", data)
				}
				req.Params.OnUsage = func(info DispatchUsageInfo) {
					info.Name = agentName
					data, _ := json.Marshal(info)
					h.sendNotification("dispatch_usage", data)
				}
				req.Params.OnTextDelta = func(info DispatchTextDeltaInfo) {
					info.Name = agentName
					data, _ := json.Marshal(info)
					h.sendNotification("dispatch_text_delta", data)
				}
				req.Params.OnPlanProposal = func(info DispatchPlanProposalInfo) {
					info.Name = agentName
					data, _ := json.Marshal(info)
					h.sendNotification("dispatch_plan_proposal", data)
				}
				req.Params.OnChildQuestion = h.makeOnChildQuestion(agentName)

				// Dispatch in a goroutine; respond immediately with stub.
				go func() {
					result, err := ctx.DispatchAgent(req.Params)
					if err != nil {
						// For background dispatch, the error shouldn't happen
						// at the stub level, but handle defensively.
						h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
						return
					}
					data, _ := json.Marshal(result)
					h.sendResponse(id, json.RawMessage(data), nil)
				}()
			} else {
				// Foreground dispatch: run in goroutine, send response when done.
				// Wire OnChildQuestion so foreground child questions block-and-resume.
				agentName := req.Params.Name
				req.Params.OnChildQuestion = h.makeOnChildQuestion(agentName)
				go func() {
					result, err := ctx.DispatchAgent(req.Params)
					if err != nil {
						h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
						return
					}
					data, _ := json.Marshal(result)
					h.sendResponse(id, json.RawMessage(data), nil)
				}()
			}
		} else {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "dispatch not available"})
		}

	case "ext/recall_agent":
		h.handleRecallRPC(ctx, id, raw)

	case "ext/register_agent_spec":
		var req struct {
			Params types.AgentSpec `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return
		}
		if ctx == nil || ctx.RegisterAgentSpec == nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "agent spec registration not available"})
			return
		}
		if req.Params.Name == "" {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "spec.name is required"})
			return
		}
		ctx.RegisterAgentSpec(req.Params)
		h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)

	case "ext/deregister_agent_spec":
		var req struct {
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return
		}
		if ctx != nil && ctx.DeregisterAgentSpec != nil {
			ctx.DeregisterAgentSpec(req.Params.Name)
		}
		h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)

	case "ext/elicit":
		var req struct {
			Params struct {
				RequestID string                 `json:"requestId,omitempty"`
				Schema    map[string]interface{} `json:"schema,omitempty"`
				URL       string                 `json:"url,omitempty"`
				Mode      string                 `json:"mode,omitempty"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return
		}
		if ctx == nil || ctx.Elicit == nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "elicit not available"})
			return
		}
		go func() {
			resp, cancelled, err := ctx.Elicit(ElicitationRequestInfo{
				RequestID: req.Params.RequestID,
				Schema:    req.Params.Schema,
				URL:       req.Params.URL,
				Mode:      req.Params.Mode,
			})
			if err != nil {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
				return
			}
			data, _ := json.Marshal(struct {
				Response  map[string]interface{} `json:"response,omitempty"`
				Cancelled bool                   `json:"cancelled"`
			}{Response: resp, Cancelled: cancelled})
			h.sendResponse(id, json.RawMessage(data), nil)
		}()

	case "ext/answer_dispatch_question":
		h.handleAnswerDispatchQuestion(id, raw)

	case "ext/send_prompt":
		var req struct {
			Params struct {
				Text                   string   `json:"text"`
				Model                  string   `json:"model,omitempty"`
				BashAllowlistAdditions []string `json:"bashAllowlistAdditions,omitempty"`
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
			// per-prompt bash-allowlist additions, recursion guard).
			utils.LogWithFields(utils.LevelDebug, "extension", "ext/send_prompt: hook ctx path", map[string]any{"model": req.Params.Model, "count": len(req.Params.BashAllowlistAdditions)})
			go func() {
				if err := ctx.SendPrompt(req.Params.Text, req.Params.Model, req.Params.BashAllowlistAdditions); err != nil {
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
		// bash-allowlist additions), identical to the active-hook path above —
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
		utils.LogWithFields(utils.LevelInfo, "extension", "ext/send_prompt: fallback path via onsendmessage forwarding full payload", map[string]any{"model": req.Params.Model, "count": len(req.Params.BashAllowlistAdditions)})
		go func() {
			fn(SendPromptPayload{
				Text:                   req.Params.Text,
				Model:                  req.Params.Model,
				BashAllowlistAdditions: req.Params.BashAllowlistAdditions,
			})
			h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
		}()

	case "ext/call_tool":
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
				data, _ := json.Marshal(struct {
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
			data, _ := json.Marshal(struct {
				Content string `json:"content"`
				IsError bool   `json:"isError,omitempty"`
			}{Content: content, IsError: isError})
			h.sendResponse(id, json.RawMessage(data), nil)
		}()

	case "ext/get_context_usage":
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

	case "ext/search_history":
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

	case "ext/get_session_memory":
		h.handleGetSessionMemory(id, ctx)
	case "ext/set_session_memory":
		h.handleSetSessionMemory(id, raw, ctx)

	case "ext/sandbox_wrap":
		var req struct {
			Params struct {
				Command            string                      `json:"command"`
				Platform           string                      `json:"platform,omitempty"`
				FSAllowWrite       []string                    `json:"fsAllowWrite,omitempty"`
				FSDenyWrite        []string                    `json:"fsDenyWrite,omitempty"`
				FSDenyRead         []string                    `json:"fsDenyRead,omitempty"`
				NetAllowedDomains  []string                    `json:"netAllowedDomains,omitempty"`
				NetBlockedDomains  []string                    `json:"netBlockedDomains,omitempty"`
				NetAllowLocalBind  bool                        `json:"netAllowLocalBind,omitempty"`
				ExtraPatterns      []sandbox.DangerousPattern  `json:"extraPatterns,omitempty"`
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
		data, _ := json.Marshal(struct {
			Wrapped  string `json:"wrapped"`
			Platform string `json:"platform"`
		}{Wrapped: wrapped, Platform: func() string {
			if req.Params.Platform != "" {
				return req.Params.Platform
			}
			return sandbox.DetectPlatform()
		}()})
		h.sendResponse(id, json.RawMessage(data), nil)

	case "ext/llm_call":
		// One-shot lightweight inference. Handler lives in
		// host_rpc_llm_call.go to keep this file under the 800-line cap.
		h.handleLLMCallRPC(ctx, id, raw)

	case "ext/declare_resource":
		h.handleDeclareResource(id, raw)

	case "ext/publish_resource":
		h.handlePublishResource(id, raw)

	case "ext/notify":
		h.handleNotify(id, raw)

	case "ext/intercept":
		h.handleIntercept(id, raw)

	case "ext/list_sessions":
		h.handleListSessions(id, raw)

	case "ext/send_to_session":
		h.handleSendToSession(id, raw)

	default:
		h.sendResponse(id, nil, &jsonrpcError{Code: -32601, Message: "method not found: " + method})
	}
}

// sendResponse writes a JSON-RPC response back to the subprocess.
func (h *Host) sendResponse(id int64, result json.RawMessage, rpcErr *jsonrpcError) {
	resp := struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      int64           `json:"id"`
		Result  json.RawMessage `json:"result,omitempty"`
		Error   *jsonrpcError   `json:"error,omitempty"`
	}{
		JSONRPC: "2.0",
		ID:      id,
		Result:  result,
		Error:   rpcErr,
	}
	data, err := json.Marshal(resp)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "extension", "failed to marshal response", map[string]any{"error": err})
		return
	}
	data = append(data, '\n')
	h.pendMu.Lock()
	w := h.stdin
	h.pendMu.Unlock()
	if w != nil {
		h.writeMu.Lock()
		_, _ = w.Write(data)
		h.writeMu.Unlock()
	}
}

// sendNotification writes a JSON-RPC notification (no id) to the subprocess.
func (h *Host) sendNotification(method string, params json.RawMessage) {
	notif := struct {
		JSONRPC string          `json:"jsonrpc"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params,omitempty"`
	}{
		JSONRPC: "2.0",
		Method:  method,
		Params:  params,
	}
	data, err := json.Marshal(notif)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "extension", "failed to marshal notification", map[string]any{"error": err})
		return
	}
	data = append(data, '\n')
	h.pendMu.Lock()
	w := h.stdin
	h.pendMu.Unlock()
	if w != nil {
		h.writeMu.Lock()
		_, _ = w.Write(data)
		h.writeMu.Unlock()
	}
}
