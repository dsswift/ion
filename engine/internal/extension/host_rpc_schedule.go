// Schedule-control RPC handlers.
package extension

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

func (h *Host) handleFireSchedule(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params struct {
			ID string `json:"id"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.LogWithFields(utils.LevelInfo, "extension", "ext/fire_schedule parse error", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	if req.Params.ID == "" {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "id is required"})
		return
	}

	var fire func() error
	source := "active_context"
	if ctx != nil && ctx.FireSchedule != nil {
		fire = func() error { return ctx.FireSchedule(req.Params.ID) }
	} else {
		h.notifMu.RLock()
		persistent := h.persistentScheduleFire
		h.notifMu.RUnlock()
		if persistent == nil {
			utils.LogWithFields(utils.LevelError, "extension", "ext/fire_schedule unavailable", map[string]any{"model": h.name_(), "schedule_job_id": req.Params.ID, "source": "none"})
			h.sendResponse(id, nil, &jsonrpcError{Code: -32603, Message: "fire schedule not available"})
			return
		}
		source = "persistent"
		fire = func() error { return persistent(req.Params.ID) }
	}
	if err := fire(); err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/fire_schedule failed", map[string]any{"model": h.name_(), "schedule_job_id": req.Params.ID, "source": source, "error": err.Error()})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "extension", "ext/fire_schedule queued", map[string]any{"model": h.name_(), "schedule_job_id": req.Params.ID, "source": source})
	h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
}

func (h *Host) handleGetScheduleStatus(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params struct {
			ID string `json:"id"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.LogWithFields(utils.LevelInfo, "extension", "ext/get_schedule_status parse error", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}

	var status func() ([]ScheduleStatusEntry, error)
	source := "active_context"
	if ctx != nil && ctx.GetScheduleStatus != nil {
		status = func() ([]ScheduleStatusEntry, error) { return ctx.GetScheduleStatus(req.Params.ID) }
	} else {
		h.notifMu.RLock()
		persistent := h.persistentScheduleStatus
		h.notifMu.RUnlock()
		if persistent == nil {
			utils.LogWithFields(utils.LevelError, "extension", "ext/get_schedule_status unavailable", map[string]any{"model": h.name_(), "schedule_job_id": req.Params.ID, "source": "none"})
			h.sendResponse(id, json.RawMessage(`[]`), nil)
			return
		}
		source = "persistent"
		status = func() ([]ScheduleStatusEntry, error) { return persistent(req.Params.ID) }
	}
	entries, err := status()
	if err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/get_schedule_status failed", map[string]any{"model": h.name_(), "schedule_job_id": req.Params.ID, "source": source, "error": err.Error()})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	if entries == nil {
		entries = []ScheduleStatusEntry{}
	}
	data, err := json.Marshal(entries)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/get_schedule_status marshal error", map[string]any{"error": err.Error()})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "marshal error"})
		return
	}
	utils.LogWithFields(utils.LevelDebug, "extension", "ext/get_schedule_status returned", map[string]any{"model": h.name_(), "schedule_job_id": req.Params.ID, "source": source, "count": len(entries)})
	h.sendResponse(id, data, nil)
}
