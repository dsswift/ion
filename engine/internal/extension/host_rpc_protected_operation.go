// host_rpc_protected_operation.go — ext/protected_operation RPC handler.
//
// Bridges the TypeScript SDK's ctx.protectedOperation to DoProtectedOperation
// (protected_operation.go). A call made inside a hook runs through that
// context's ProtectedOperation, which carries the acting principal. A call
// with no hook context (schedules, webhooks) uses the unattributed
// credential-store partition.
package extension

import (
	"context"
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

// rpcProtectedOperation answers ext/protected_operation, registered in
// host_rpc_registry.go.
func (h *Host) rpcProtectedOperation(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params ProtectedOperationParams `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "ext/protected_operation: parse error", map[string]any{"error": err.Error()})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	run := func(params ProtectedOperationParams) (*ProtectedOperationResult, error) {
		return DoProtectedOperation(context.Background(), params)
	}
	if ctx != nil && ctx.ProtectedOperation != nil {
		run = ctx.ProtectedOperation
	}

	// Perform the call off the RPC read loop; the response is delivered
	// asynchronously by id like every other long-running ext/* method.
	go func() {
		resp, err := run(req.Params)
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension", "ext/protected_operation: failed", map[string]any{
				"extension": h.name_(), "operation": req.Params.Name, "error": err.Error(),
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
}
