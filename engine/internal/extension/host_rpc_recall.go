package extension

import (
	"encoding/json"
)

// handleRecallRPC handles the ext/recall_agent request. It resolves the recall
// function from the active hook/run context when one is present, and otherwise
// falls back to the session-scoped persistent recall.
//
// Extracted from host_rpc.go to keep that file under the 800-line cap.
//
// The fallback matters because the dispatch registry outlives runs by design
// (that is the point of a background dispatch). A watchdog timeout that fires
// after the dispatching run has gone idle must still be able to cancel the
// background agent even though ctxStack is empty — otherwise recall silently
// falls through to "recall not available" whenever the parent is idle.
func (h *Host) handleRecallRPC(ctx *Context, id int64, raw []byte) {
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
	// Resolve recall function: prefer active context, fall back to the
	// session-scoped persistent recall for the idle-parent case.
	var recallFn func(name string, opts RecallAgentOpts) (bool, error)
	if ctx != nil && ctx.RecallAgent != nil {
		recallFn = ctx.RecallAgent
	} else {
		h.notifMu.RLock()
		pRecall := h.persistentRecall
		h.notifMu.RUnlock()
		if pRecall != nil {
			recallFn = func(name string, opts RecallAgentOpts) (bool, error) {
				reason := opts.Reason
				if reason == "" {
					reason = "recall_agent"
				}
				return pRecall(name, reason)
			}
		}
	}
	if recallFn != nil {
		found, err := recallFn(req.Params.Name, RecallAgentOpts{
			Reason: req.Params.Reason,
		})
		if err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
			return
		}
		data, _ := json.Marshal(struct {
			Found bool `json:"found"`
		}{Found: found})
		h.sendResponse(id, json.RawMessage(data), nil)
	} else {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "recall not available"})
	}
}
