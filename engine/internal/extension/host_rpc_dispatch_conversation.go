package extension

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

// rpcReadDispatchConversation answers ext/read_dispatch_conversation: one
// bounded page of the conversation of a dispatch the calling context owns.
// Every refusal is a typed outcome in a successful response, so a caller
// branches on data rather than on error text. A context with no dispatch
// lineage wired cannot prove ownership of anything and is answered
// "unauthorized".
func (h *Host) rpcReadDispatchConversation(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params ReadDispatchConversationOpts `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.LogWithFields(utils.LevelWarn, "extension", "ext/read_dispatch_conversation: invalid params", map[string]any{"error": err.Error()})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "invalid params: " + err.Error()})
		return
	}
	opts := req.Params
	if opts.ConversationID == "" && opts.DispatchID == "" {
		utils.Log("extension", "ext/read_dispatch_conversation: neither conversationId nor dispatchId given")
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "conversationId or dispatchId is required"})
		return
	}

	fields := map[string]any{"conversation_id": opts.ConversationID, "dispatch_id": opts.DispatchID}
	var result *DispatchConversationResult
	if ctx == nil || ctx.ReadDispatchConversation == nil {
		utils.LogWithFields(utils.LevelWarn, "extension", "ext/read_dispatch_conversation: no dispatch lineage on this context, refusing", fields)
		result = &DispatchConversationResult{Outcome: DispatchConversationUnauthorized}
	} else {
		var err error
		result, err = ctx.ReadDispatchConversation(opts)
		if err != nil {
			fields["error"] = err.Error()
			utils.LogWithFields(utils.LevelError, "extension", "ext/read_dispatch_conversation: read failed", fields)
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
			return
		}
	}
	if result.Entries == nil {
		result.Entries = []DispatchConversationEntry{}
	}
	data, err := json.Marshal(result)
	if err != nil {
		fields["error"] = err.Error()
		utils.LogWithFields(utils.LevelError, "extension", "ext/read_dispatch_conversation: marshal failed", fields)
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
		return
	}
	fields["outcome"] = result.Outcome
	fields["count"] = len(result.Entries)
	fields["has_more"] = result.HasMore
	utils.LogWithFields(utils.LevelDebug, "extension", "ext/read_dispatch_conversation: returning", fields)
	h.sendResponse(id, json.RawMessage(data), nil)
}
