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
			utils.Log("extension", fmt.Sprintf("ext/emit parse error: %v", err))
			return
		}
		// Resolve emit function: prefer active context, fall back to persistent emit
		var emitFn func(types.EngineEvent)
		if ctx := h.currentCtx.Load(); ctx != nil && ctx.Emit != nil {
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
			utils.Log("extension", fmt.Sprintf("ext/send_message parse error: %v", err))
			return
		}
		h.notifMu.RLock()
		fn := h.onSendMessage
		h.notifMu.RUnlock()
		if fn != nil && notif.Params.Text != "" {
			fn(notif.Params.Text)
		}
	case "log":
		// Native SDK logging channel. Routes structured log calls (and
		// redirected console.* output) through the JSON-RPC frame so
		// nothing ever lands on the subprocess's raw stdout.
		var notif struct {
			Params struct {
				Level   string         `json:"level"`
				Message string         `json:"message"`
				Fields  map[string]any `json:"fields,omitempty"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &notif); err != nil {
			utils.Log("extension", fmt.Sprintf("log notif parse error: %v", err))
			return
		}
		tag := "ext"
		if h.name != "" {
			tag = "ext:" + h.name
		}
		body := notif.Params.Message
		if len(notif.Params.Fields) > 0 {
			if extra, err := json.Marshal(notif.Params.Fields); err == nil {
				body = body + " " + string(extra)
			}
		}
		switch notif.Params.Level {
		case "error":
			utils.Error(tag, body)
		case "warn":
			utils.Warn(tag, body)
		case "debug":
			utils.Debug(tag, body)
		default:
			utils.Info(tag, body)
		}
	default:
		utils.Log("extension", fmt.Sprintf("unknown notification method: %s", method))
	}
}

// handleExtRequest processes extension-initiated JSON-RPC requests (messages
// with both a method and id field). The engine sends a response back.
func (h *Host) handleExtRequest(method string, id int64, raw []byte) {
	ctx := h.currentCtx.Load()
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

	case "ext/dispatch_agent":
		var req struct {
			Params DispatchAgentOpts `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return
		}
		if ctx != nil && ctx.DispatchAgent != nil {
			go func() {
				// Wire OnEvent to send JSON-RPC notifications during dispatch
				req.Params.OnEvent = func(ev types.EngineEvent) {
					evData, err := json.Marshal(ev)
					if err == nil {
						h.sendNotification("dispatch_event", evData)
					}
				}
				result, err := ctx.DispatchAgent(req.Params)
				if err != nil {
					h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
					return
				}
				data, _ := json.Marshal(result)
				h.sendResponse(id, json.RawMessage(data), nil)
			}()
		} else {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "dispatch not available"})
		}

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

	case "ext/send_prompt":
		var req struct {
			Params struct {
				Text  string `json:"text"`
				Model string `json:"model,omitempty"`
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
		if ctx == nil || ctx.SendPrompt == nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "sendPrompt not available outside an active session"})
			return
		}
		go func() {
			if err := ctx.SendPrompt(req.Params.Text, req.Params.Model); err != nil {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
				return
			}
			h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
		}()

	case "ext/call_tool":
		var req struct {
			Params struct {
				Name  string                 `json:"name"`
				Input map[string]interface{} `json:"input"`
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
		utils.Log("extension", fmt.Sprintf("failed to marshal response: %v", err))
		return
	}
	data = append(data, '\n')
	if h.stdin != nil {
		h.stdin.Write(data)
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
		utils.Log("extension", fmt.Sprintf("failed to marshal notification: %v", err))
		return
	}
	data = append(data, '\n')
	if h.stdin != nil {
		h.stdin.Write(data)
	}
}
