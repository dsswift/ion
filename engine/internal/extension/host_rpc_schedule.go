// Schedule-related RPC handlers for the extension host. Implements:
//   ext/fire_schedule       -- extension triggers an immediate schedule fire
//   ext/get_schedule_status -- extension queries schedule job status
//
// Pattern mirrors host_rpc_resource.go: parse params, get ctx, call the
// wired function, send success or error response.

package extension

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

// handleScheduleRPC dispatches schedule-related ext/* RPCs. Returns true
// when the method was handled, false when it should fall through to the
// main switch.
func (h *Host) handleScheduleRPC(method string, id int64, raw []byte) bool {
	switch method {
	case "ext/fire_schedule":
		h.handleFireSchedule(id, raw)
		return true
	case "ext/get_schedule_status":
		h.handleGetScheduleStatus(id, raw)
		return true
	default:
		return false
	}
}

func (h *Host) handleFireSchedule(id int64, raw []byte) {
	var req struct {
		Params struct {
			ID string `json:"id"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.LogWithFields(utils.LevelInfo, "extension", "ext/fire_schedule: parse error", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	if req.Params.ID == "" {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "id is required"})
		return
	}

	ctx := h.ctxStack.Current()
	if ctx == nil || ctx.FireSchedule == nil {
		utils.Debug("extension", "ext/fire_schedule: no ctx or FireSchedule not wired")
		h.sendResponse(id, nil, &jsonrpcError{Code: -32603, Message: "fire schedule not available"})
		return
	}

	if err := ctx.FireSchedule(req.Params.ID); err != nil {
		utils.LogWithFields(utils.LevelInfo, "extension", "ext/fire_schedule: error", map[string]any{"run_id": req.Params.ID, "error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}

	utils.LogWithFields(utils.LevelDebug, "extension", "ext/fire_schedule: fired", map[string]any{"model": h.name, "run_id": req.Params.ID})
	h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
}

func (h *Host) handleGetScheduleStatus(id int64, raw []byte) {
	var req struct {
		Params struct {
			ID string `json:"id"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.LogWithFields(utils.LevelInfo, "extension", "ext/get_schedule_status: parse error", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}

	ctx := h.ctxStack.Current()
	if ctx == nil || ctx.GetScheduleStatus == nil {
		utils.Debug("extension", "ext/get_schedule_status: no ctx or GetScheduleStatus not wired")
		h.sendResponse(id, json.RawMessage(`[]`), nil)
		return
	}

	entries, err := ctx.GetScheduleStatus(req.Params.ID)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "extension", "ext/get_schedule_status: error", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	if entries == nil {
		entries = []ScheduleStatusEntry{}
	}

	data, err := json.Marshal(entries)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/get_schedule_status: marshal error", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "marshal error"})
		return
	}

	utils.LogWithFields(utils.LevelDebug, "extension", "ext/get_schedule_status: returning entries", map[string]any{"model": h.name, "count": len(entries)})
	h.sendResponse(id, data, nil)
}
