package extension

import (
	"encoding/json"
	"fmt"

	"github.com/dsswift/ion/engine/internal/utils"
)

// handleRecallAgentRPC handles the name-addressed ext/recall_agent request.
// The response keeps its original found field and adds outcome and, for an
// ambiguous name, matchingDispatchIds.
func (h *Host) handleRecallAgentRPC(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params struct {
			Name   string `json:"name"`
			Reason string `json:"reason,omitempty"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	if req.Params.Name == "" {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "name is required"})
		return
	}

	var recallFn func(name string, opts RecallAgentOpts) (RecallAgentResult, error)
	if ctx != nil && ctx.RecallAgent != nil {
		recallFn = ctx.RecallAgent
	} else {
		h.notifMu.RLock()
		persistentRecall := h.persistentRecall
		h.notifMu.RUnlock()
		if persistentRecall != nil {
			recallFn = func(name string, opts RecallAgentOpts) (RecallAgentResult, error) {
				reason := opts.Reason
				if reason == "" {
					reason = "recall_agent"
				}
				return persistentRecall(name, reason)
			}
		}
	}
	if recallFn == nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "recall not available"})
		return
	}

	result, err := recallFn(req.Params.Name, RecallAgentOpts{Reason: req.Params.Reason})
	if err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	data, _ := json.Marshal(result) //nolint:errcheck // marshal of a local RPC struct
	h.sendResponse(id, json.RawMessage(data), nil)
}

// handleRecallDispatchRPC handles the exact-ID ext/recall_dispatch request.
// A live child context receives ancestry-scoped recall through its Context;
// contextless work uses the session-root persistent callback.
func (h *Host) handleRecallDispatchRPC(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params struct {
			DispatchID string `json:"dispatchId"`
			Reason     string `json:"reason,omitempty"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	if req.Params.DispatchID == "" {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "dispatchId is required"})
		return
	}

	var recallFn func(dispatchID string, opts RecallDispatchOpts) (RecallDispatchResult, error)
	if ctx != nil && ctx.RecallDispatch != nil {
		recallFn = ctx.RecallDispatch
	} else {
		h.notifMu.RLock()
		persistentRecall := h.persistentRecallByID
		h.notifMu.RUnlock()
		if persistentRecall != nil {
			recallFn = func(dispatchID string, opts RecallDispatchOpts) (RecallDispatchResult, error) {
				reason := opts.Reason
				if reason == "" {
					reason = "recall_dispatch"
				}
				return persistentRecall(dispatchID, reason)
			}
		}
	}
	if recallFn == nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "recall not available"})
		return
	}

	result, err := recallFn(req.Params.DispatchID, RecallDispatchOpts{Reason: req.Params.Reason})
	if err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	if result.Outcome == "unauthorized" {
		// An unauthorized recall has always been a handler error on this
		// method. It stays one, and now carries the typed outcome.
		utils.LogWithFields(utils.LevelWarn, "extension", "ext/recall_dispatch: caller does not own dispatch", map[string]any{"dispatch_id": req.Params.DispatchID})
		h.sendResponse(id, nil, &jsonrpcError{
			Code:    -32000,
			Message: fmt.Sprintf("dispatch %q is not a descendant owned by the caller", req.Params.DispatchID),
			Data:    &jsonrpcErrData{Outcome: "unauthorized"},
		})
		return
	}
	data, _ := json.Marshal(result) //nolint:errcheck // marshal of a local RPC struct
	h.sendResponse(id, json.RawMessage(data), nil)
}
