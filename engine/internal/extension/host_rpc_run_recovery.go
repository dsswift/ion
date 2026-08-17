package extension

import (
	"bytes"
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// handleSetRunRecovery handles ext/set_run_recovery: an extension calls
// ctx.setRunRecovery({enabled, maxAttempts, ...}) and the engine applies
// the config as a per-session override.
func (h *Host) handleSetRunRecovery(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params types.RunRecoveryConfig `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}

	if ctx == nil || ctx.SetRunRecovery == nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32603, Message: "run recovery not available in this context"})
		return
	}

	if req.Params.Enabled == nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "enabled is required"})
		return
	}
	if bytes.Contains(raw, []byte(`"journalDir"`)) ||
		bytes.Contains(raw, []byte(`"maxAgeSec"`)) ||
		bytes.Contains(raw, []byte(`"staleThresholdSec"`)) {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "unsupported run recovery field"})
		return
	}

	ctx.SetRunRecovery(&req.Params)
	utils.LogWithFields(utils.LevelInfo, "extension", "ext/set_run_recovery", map[string]any{
		"extension": h.name_(), "enabled": *req.Params.Enabled, "max_attempts": req.Params.MaxAttempts,
	})
	h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
}
