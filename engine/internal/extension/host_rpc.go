package extension

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

// handleExtNotification processes extension-initiated JSON-RPC notifications
// (messages with a method field but no pending response ID). These allow
// extensions to emit events and queue messages back to the engine.
//
// Dispatch is a lookup into extNotificationHandlers (host_rpc_registry.go),
// so the declared registry and the answered method set cannot drift.
func (h *Host) handleExtNotification(method string, raw []byte) {
	h.handleExtNotificationWithContext(method, h.ctxStack.Current(), raw)
}

// handleExtNotificationWithContext dispatches a notification against the
// context captured when its frame was read. The inbound worker may run after
// the engine-to-extension call has returned and popped ctxStack, so resolving
// the context here would lose tool- and hook-scoped callbacks such as Emit.
func (h *Host) handleExtNotificationWithContext(method string, ctx *Context, raw []byte) {
	handler, ok := extNotificationHandlers[method]
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "extension", "unknown notification method", map[string]any{"method": method})
		return
	}
	handler(h, ctx, raw)
}

// handleExtRequest processes extension-initiated JSON-RPC requests (messages
// with both a method and id field). The engine sends a response back.
//
// Dispatch is a lookup into extRequestHandlers (host_rpc_registry.go). An
// unregistered method answers -32601, which client SDKs read as "this engine
// build does not have that capability" and degrade on rather than treating
// as fatal.
func (h *Host) handleExtRequest(method string, id int64, raw []byte) {
	h.handleExtRequestWithContext(method, id, h.ctxStack.Current(), raw)
}

// handleExtRequestWithContext is handleExtRequest with the dispatch context
// supplied by the caller. The readLoop captures the ctxStack top when it reads
// the frame and passes it here, so a request dispatched a moment later by the
// inbound queue still runs against the context that was current on the wire.
func (h *Host) handleExtRequestWithContext(method string, id int64, reqCtx *Context, raw []byte) {
	handler, ok := extRequestHandlers[method]
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "extension", "unknown ext request method", map[string]any{"method": method, "extension": h.name_()})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32601, Message: "method not found: " + method})
		return
	}
	handler(h, reqCtx, id, raw)
}

// sendResponse writes a JSON-RPC response back to the subprocess.
func (h *Host) sendResponse(id int64, result json.RawMessage, rpcErr *jsonrpcError) {
	resp := struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      int64           `json:"id"`
		Result  json.RawMessage `json:"result,omitempty"`
		Error   *jsonrpcError   `json:"error,omitempty"`
	}{
		JSONRPC: "2.0",
		ID:      id,
		Result:  result,
		Error:   rpcErr,
	}
	data, err := json.Marshal(resp)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "extension", "failed to marshal response", map[string]any{"error": err})
		return
	}
	data = append(data, '\n')
	h.pendMu.Lock()
	w := h.stdin
	h.pendMu.Unlock()
	if w != nil {
		h.writeMu.Lock()
		_, werr := w.Write(data)
		h.writeMu.Unlock()
		if werr != nil {
			// A failed stdin write means the extension never receives its RPC
			// reply and blocks/times out with no engine-side record.
			utils.LogWithFields(utils.LevelInfo, "extension", "rpc response stdin write failed", map[string]any{"extension": h.name_(), "id": id, "error": werr.Error()})
		}
	}
}

// sendNotification writes a JSON-RPC notification (no id) to the subprocess.
func (h *Host) sendNotification(method string, params json.RawMessage) {
	notif := struct {
		JSONRPC string          `json:"jsonrpc"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params,omitempty"`
	}{
		JSONRPC: "2.0",
		Method:  method,
		Params:  params,
	}
	data, err := json.Marshal(notif)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "extension", "failed to marshal notification", map[string]any{"error": err})
		return
	}
	data = append(data, '\n')
	h.pendMu.Lock()
	w := h.stdin
	h.pendMu.Unlock()
	if w != nil {
		h.writeMu.Lock()
		_, werr := w.Write(data)
		h.writeMu.Unlock()
		if werr != nil {
			// A failed notification write means the extension never receives
			// this message; log so the drop is visible.
			utils.LogWithFields(utils.LevelInfo, "extension", "rpc notification stdin write failed", map[string]any{"extension": h.name_(), "method": method, "error": werr.Error()})
		}
	}
}
