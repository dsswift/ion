package extension

import "encoding/json"

// handleRecallAgentRPC retains the published name-addressed ext/recall_agent
// request. The exact-ID ext/recall_dispatch peer is preferred for new callers,
// but existing extensions keep their original behavior.
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

	var recallFn func(name string, opts RecallAgentOpts) (bool, error)
	if ctx != nil && ctx.RecallAgent != nil {
		recallFn = ctx.RecallAgent
	} else {
		h.notifMu.RLock()
		persistentRecall := h.persistentRecall
		h.notifMu.RUnlock()
		if persistentRecall != nil {
			recallFn = func(name string, opts RecallAgentOpts) (bool, error) {
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

	found, err := recallFn(req.Params.Name, RecallAgentOpts{Reason: req.Params.Reason})
	if err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	h.sendRecallFoundResponse(id, found)
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

	var recallFn func(dispatchID string, opts RecallDispatchOpts) (bool, error)
	if ctx != nil && ctx.RecallDispatch != nil {
		recallFn = ctx.RecallDispatch
	} else {
		h.notifMu.RLock()
		persistentRecall := h.persistentRecallByID
		h.notifMu.RUnlock()
		if persistentRecall != nil {
			recallFn = func(dispatchID string, opts RecallDispatchOpts) (bool, error) {
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

	found, err := recallFn(req.Params.DispatchID, RecallDispatchOpts{Reason: req.Params.Reason})
	if err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	h.sendRecallFoundResponse(id, found)
}

func (h *Host) sendRecallFoundResponse(id int64, found bool) {
	data, _ := json.Marshal(struct { //nolint:errcheck // local response cannot fail
		Found bool `json:"found"`
	}{Found: found})
	h.sendResponse(id, json.RawMessage(data), nil)
}
