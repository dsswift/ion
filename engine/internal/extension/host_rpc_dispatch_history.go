package extension

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

// rpcListDispatchHistory answers ext/list_dispatch_history: the retained
// terminal dispatches the calling context owns, as a { dispatches: [...] }
// envelope. It is the terminal peer of ext/list_dispatch_state, which stays
// live-only. Returns an empty array (not null) when nothing is retained or
// when the getter is not wired.
func (h *Host) rpcListDispatchHistory(ctx *Context, id int64, _ []byte) {
	if ctx == nil || ctx.ListDispatchHistory == nil {
		utils.Debug("extension", "ext/list_dispatch_history: no ctx or no getter, returning empty array")
		h.sendResponse(id, json.RawMessage(`{"dispatches":[]}`), nil)
		return
	}
	entries, err := ctx.ListDispatchHistory()
	if err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/list_dispatch_history: getter returned error", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	if entries == nil {
		entries = []DispatchHistoryEntry{}
	}
	data, err := json.Marshal(struct {
		Dispatches []DispatchHistoryEntry `json:"dispatches"`
	}{Dispatches: entries})
	if err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/list_dispatch_history: marshal failed", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	utils.LogWithFields(utils.LevelDebug, "extension", "ext/list_dispatch_history: returning", map[string]any{"count": len(entries)})
	h.sendResponse(id, json.RawMessage(data), nil)
}
