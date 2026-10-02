package extension

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// rpcReadConversation answers ext/read_conversation: one page of a
// conversation record, read from disk by conversation ID, as a
// { messages, total, hasMore } envelope. A negative offset or limit is
// treated as 0; limit 0 returns every message from offset onward.
func (h *Host) rpcReadConversation(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params struct {
			ConversationID string `json:"conversationId"`
			Offset         int    `json:"offset,omitempty"`
			Limit          int    `json:"limit,omitempty"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/read_conversation: parse error", map[string]any{"error": err.Error()})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	convID, offset, limit := req.Params.ConversationID, max(req.Params.Offset, 0), max(req.Params.Limit, 0)
	fields := map[string]any{"extension": h.name_(), "conversation_id": convID, "offset": offset, "limit": limit}
	if convID == "" {
		utils.LogWithFields(utils.LevelWarn, "extension", "ext/read_conversation: missing conversationId", fields)
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "conversationId is required"})
		return
	}
	if ctx == nil || ctx.ReadConversation == nil {
		utils.LogWithFields(utils.LevelWarn, "extension", "ext/read_conversation: no ctx or reader not wired", fields)
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "conversation read is unavailable outside a session context"})
		return
	}
	record, err := ctx.ReadConversation(convID, offset, limit)
	if err != nil {
		fields["error"] = err.Error()
		utils.LogWithFields(utils.LevelWarn, "extension", "ext/read_conversation: read failed", fields)
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	if record == nil {
		record = &ConversationRecord{}
	}
	if record.Messages == nil {
		record.Messages = []types.SessionMessage{}
	}
	data, err := json.Marshal(record)
	if err != nil {
		fields["error"] = err.Error()
		utils.LogWithFields(utils.LevelError, "extension", "ext/read_conversation: marshal failed", fields)
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	fields["count"], fields["total"], fields["has_more"] = len(record.Messages), record.Total, record.HasMore
	utils.LogWithFields(utils.LevelDebug, "extension", "ext/read_conversation: returning", fields)
	h.sendResponse(id, json.RawMessage(data), nil)
}
