// host_rpc_http.go — ext/http_request RPC handler.
//
// Bridges the TypeScript SDK's ctx.http.* surface to the engine's
// pre-authenticated outbound HTTP implementation (http_request.go). The
// handler is deliberately session-independent: minting an operator token
// requires no session state, so extensions loaded outside an active
// session (schedules, webhooks) can still make authenticated calls.
package extension

import (
	"context"
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

// handleHTTPRPC dispatches the ext/http_request method. Returns true when
// the method was handled (caller short-circuits its own switch).
func (h *Host) handleHTTPRPC(method string, id int64, raw []byte) bool {
	if method != "ext/http_request" {
		return false
	}

	var req struct {
		Params OperatorHTTPRequestParams `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/http_request: parse error", map[string]any{"error": err.Error()})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return true
	}

	// Perform the request off the RPC read loop; the response is delivered
	// asynchronously by id like every other long-running ext/* method.
	go func() {
		resp, err := DoOperatorHTTPRequest(context.Background(), req.Params)
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension", "ext/http_request: failed", map[string]any{
				"model": h.name,
				"url":   req.Params.URL,
				"error": err.Error(),
			})
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
			return
		}
		data, err := json.Marshal(resp)
		if err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "marshal response: " + err.Error()})
			return
		}
		h.sendResponse(id, json.RawMessage(data), nil)
	}()
	return true
}
