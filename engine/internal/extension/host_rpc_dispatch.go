// host_rpc_dispatch.go — agent-dispatch, elicitation, and run-suspension ext/* handlers.
//
// Extracted from the handleExtRequest switch when that switch became
// the declared registry in host_rpc_registry.go. Dispatch is asynchronous by
// default; WaitForCompletion is the explicit foreground opt-in.

package extension

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

func (h *Host) rpcDispatchAgent(ctx *Context, id int64, raw []byte) {
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

		if !req.Params.WaitForCompletion {
			// Asynchronous dispatch: wire completion callbacks to notifications,
			// respond immediately with a stub.
			agentName := req.Params.Name
			req.Params.OnComplete = func(result DispatchAgentResult) {
				result.Name = agentName
				data, _ := json.Marshal(result) //nolint:errcheck // marshal of a local RPC struct
				h.sendNotification("dispatch_complete", data)
			}
			req.Params.OnError = func(err DispatchError) {
				err.Name = agentName
				data, _ := json.Marshal(err) //nolint:errcheck // marshal of a local RPC struct
				h.sendNotification("dispatch_error", data)
			}
			req.Params.OnRecall = func(info RecallInfo) {
				info.Name = agentName
				data, _ := json.Marshal(info) //nolint:errcheck // marshal of a local RPC struct
				h.sendNotification("dispatch_recall", data)
			}

			// Wire lifecycle callbacks to notifications.
			req.Params.OnToolStart = func(info DispatchToolStartInfo) {
				info.Name = agentName
				data, _ := json.Marshal(info) //nolint:errcheck // marshal of a local RPC struct
				h.sendNotification("dispatch_tool_start", data)
			}
			req.Params.OnToolEnd = func(info DispatchToolEndInfo) {
				info.Name = agentName
				data, _ := json.Marshal(info) //nolint:errcheck // marshal of a local RPC struct
				h.sendNotification("dispatch_tool_end", data)
			}
			req.Params.OnToolError = func(info DispatchToolErrorInfo) {
				info.Name = agentName
				data, _ := json.Marshal(info) //nolint:errcheck // marshal of a local RPC struct
				h.sendNotification("dispatch_tool_error", data)
			}
			req.Params.OnUsage = func(info DispatchUsageInfo) {
				info.Name = agentName
				data, _ := json.Marshal(info) //nolint:errcheck // marshal of a local RPC struct
				h.sendNotification("dispatch_usage", data)
			}
			req.Params.OnTextDelta = func(info DispatchTextDeltaInfo) {
				info.Name = agentName
				data, _ := json.Marshal(info) //nolint:errcheck // marshal of a local RPC struct
				h.sendNotification("dispatch_text_delta", data)
			}
			req.Params.OnPlanProposal = func(info DispatchPlanProposalInfo) {
				info.Name = agentName
				data, _ := json.Marshal(info) //nolint:errcheck // marshal of a local RPC struct
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
				data, _ := json.Marshal(result) //nolint:errcheck // marshal of a local RPC struct
				h.sendResponse(id, json.RawMessage(data), nil)
			}()
		} else {
			// Foreground dispatch is an explicit WaitForCompletion opt-in.
			// Wire OnChildQuestion so foreground child questions block-and-resume.
			agentName := req.Params.Name
			req.Params.OnChildQuestion = h.makeOnChildQuestion(agentName)
			go func() {
				result, err := ctx.DispatchAgent(req.Params)
				if err != nil {
					h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
					return
				}
				data, _ := json.Marshal(result) //nolint:errcheck // marshal of a local RPC struct
				h.sendResponse(id, json.RawMessage(data), nil)
			}()
		}
	} else {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "dispatch not available"})
	}
}

func (h *Host) rpcElicit(ctx *Context, id int64, raw []byte) {
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
		data, _ := json.Marshal(struct { //nolint:errcheck // marshal of a local RPC struct
			Response  map[string]interface{} `json:"response,omitempty"`
			Cancelled bool                   `json:"cancelled"`
		}{Response: resp, Cancelled: cancelled})
		h.sendResponse(id, json.RawMessage(data), nil)
	}()
}

func (h *Host) rpcTaskSuspend(ctx *Context, id int64, raw []byte) {
	// ext/task_suspend — end the current LLM run without completing it.
	// Two shapes, both reached through ctx.Suspend:
	//
	//   Inside a dispatched run: the agent's LLM exits cleanly (saving
	//   tokens, showing as idle/suspended), the parent's OnComplete does
	//   NOT fire, and runChild blocks on reviveCh until a sendPrompt to
	//   this session or until all awaiting child dispatches complete.
	//
	//   At depth 0 (the orchestrator): the root run ends and the session
	//   parks on its outstanding background bash commands, resuming when
	//   one completes. The root has no runChild goroutine to revive, so
	//   the session layer starts a fresh run instead. Rejected when
	//   nothing is outstanding to park on — see ParkMainLoop.
	var req struct {
		Params struct {
			AwaitingDispatchIDs []string `json:"awaitingDispatchIds,omitempty"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	if ctx == nil || ctx.Suspend == nil {
		utils.Debug("extension", "ext/task_suspend: no suspend capability on this context")
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "suspend not available: no active run to suspend"})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "extension", "ext/task_suspend: suspending run", map[string]any{"awaiting": len(req.Params.AwaitingDispatchIDs)})
	go func() {
		if err := ctx.Suspend(req.Params.AwaitingDispatchIDs); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
			return
		}
		h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
	}()
}
