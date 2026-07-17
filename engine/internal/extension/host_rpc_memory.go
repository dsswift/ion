package extension

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

// handleGetSessionMemory handles the ext/get_session_memory JSON-RPC method.
func (h *Host) handleGetSessionMemory(id int64, ctx *Context) {
	if ctx == nil || ctx.GetSessionMemory == nil {
		utils.Debug("extension", "ext/get_session_memory: no ctx or no getter, returning empty")
		h.sendResponse(id, json.RawMessage(`{"content":""}`), nil)
		return
	}
	content, err := ctx.GetSessionMemory()
	if err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/get_session_memory: error", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	type result struct {
		Content string `json:"content"`
	}
	data, _ := json.Marshal(result{Content: content})
	utils.LogWithFields(utils.LevelDebug, "extension", "ext/get_session_memory: returning chars", map[string]any{"count": len(content)})
	h.sendResponse(id, json.RawMessage(data), nil)
}

// handleSetSessionMemory handles the ext/set_session_memory JSON-RPC method.
func (h *Host) handleSetSessionMemory(id int64, raw []byte, ctx *Context) {
	type request struct {
		Params struct {
			Content string `json:"content"`
		} `json:"params"`
	}
	var req request
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/set_session_memory: parse error", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	if ctx == nil || ctx.SetSessionMemory == nil {
		utils.Debug("extension", "ext/set_session_memory: no ctx or no setter, ignoring")
		h.sendResponse(id, json.RawMessage(`{}`), nil)
		return
	}
	if err := ctx.SetSessionMemory(req.Params.Content); err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/set_session_memory: error", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "extension", "ext/set_session_memory: set chars", map[string]any{"count": len(req.Params.Content)})
	h.sendResponse(id, json.RawMessage(`{}`), nil)
}
