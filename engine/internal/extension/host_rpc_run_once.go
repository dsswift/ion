package extension

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

// handleRunOnceRPC returns true when method is a run_once RPC and dispatches
// it. Called from handleExtRequest before the main switch so that host_rpc.go
// stays under its 800-line cap.
func (h *Host) handleRunOnceRPC(method string, id int64, raw []byte) bool {
	switch method {
	case "ext/run_once_check":
		h.handleRunOnceCheck(id, raw)
		return true
	case "ext/run_once_complete":
		h.handleRunOnceComplete(id, raw)
		return true
	}
	return false
}

func (h *Host) handleRunOnceCheck(id int64, raw []byte) {
	var req struct {
		Params struct {
			ID         string `json:"id"`
			DebounceMs int64  `json:"debounceMs,omitempty"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	if req.Params.ID == "" {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "id is required"})
		return
	}

	ctx := h.ctxStack.Current()
	if ctx == nil || ctx.RunOnceCheck == nil {
		utils.LogWithFields(utils.LevelDebug, "extension", "ext/run_once_check: no ctx or runoncecheck not wired ()", map[string]any{"run_id": req.Params.ID})
		// Outside an active session context: allow execution so the call
		// degrades gracefully rather than hanging. Not the normal path.
		data, _ := json.Marshal(map[string]interface{}{"execute": true}) //nolint:errcheck // marshal of a local RPC struct
		h.sendResponse(id, json.RawMessage(data), nil)
		return
	}

	// debounceMs == 0 means "run once per extension lifecycle" (permanent
	// dedup until all sessions for this extension stop). The SDK sends the
	// field explicitly, so 0 is a deliberate caller choice, not an omission.
	debounceMs := req.Params.DebounceMs

	execute, reason := ctx.RunOnceCheck(req.Params.ID, debounceMs)
	utils.LogWithFields(utils.LevelDebug, "extension", "ext/run_once_check", map[string]any{"run_id": req.Params.ID, "debounce_ms": debounceMs, "execute": execute, "reason": reason})

	var data []byte
	if execute {
		data, _ = json.Marshal(map[string]interface{}{"execute": true}) //nolint:errcheck // marshal of a fixed literal map
	} else {
		data, _ = json.Marshal(map[string]interface{}{"execute": false, "reason": reason}) //nolint:errcheck // marshal of a fixed literal map
	}
	h.sendResponse(id, json.RawMessage(data), nil)
}

func (h *Host) handleRunOnceComplete(id int64, raw []byte) {
	var req struct {
		Params struct {
			ID     string `json:"id"`
			Failed bool   `json:"failed,omitempty"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	if req.Params.ID == "" {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "id is required"})
		return
	}

	ctx := h.ctxStack.Current()
	if ctx == nil || ctx.RunOnceComplete == nil {
		utils.LogWithFields(utils.LevelDebug, "extension", "ext/run_once_complete: no ctx or runoncecomplete not wired ()", map[string]any{"run_id": req.Params.ID})
		h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
		return
	}

	ctx.RunOnceComplete(req.Params.ID, req.Params.Failed)
	utils.LogWithFields(utils.LevelDebug, "extension", "ext/run_once_complete", map[string]any{"run_id": req.Params.ID, "failed": req.Params.Failed})
	h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
}
