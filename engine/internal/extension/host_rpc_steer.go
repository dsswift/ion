package extension

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

// handleSteerRPC dispatches steer-family extension RPCs. It returns true when
// it handled method, false when caller should continue its dispatch switch.
//
// Each RPC first uses live hook/tool context, then session-scoped persistent
// fallback. This lets callbacks deliver messages after parent run exits.
func (h *Host) handleSteerRPC(ctx *Context, method string, id int64, raw []byte) bool {
	switch method {
	case "ext/steer_dispatch":
		var req struct {
			Params struct {
				DispatchID string `json:"dispatchId"`
				Message    string `json:"message"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return true
		}
		go func() {
			var steerFn func(dispatchID, message string) (SteerDispatchResult, error)
			if ctx != nil && ctx.SteerDispatch != nil {
				steerFn = ctx.SteerDispatch
			} else {
				h.notifMu.RLock()
				steerFn = h.persistentSteer
				h.notifMu.RUnlock()
			}
			if steerFn == nil {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "steer dispatch not available"})
				return
			}
			result, err := steerFn(req.Params.DispatchID, req.Params.Message)
			if err != nil {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
				return
			}
			data, _ := json.Marshal(result) //nolint:errcheck // marshal of a local RPC struct
			h.sendResponse(id, json.RawMessage(data), nil)
		}()
		return true

	case "ext/steer_dispatch_by_name":
		var req struct {
			Params struct {
				Name    string `json:"name"`
				Message string `json:"message"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return true
		}
		go func() {
			var steerFn func(name, message string) (SteerDispatchResult, error)
			if ctx != nil && ctx.SteerDispatchByName != nil {
				steerFn = ctx.SteerDispatchByName
			} else {
				h.notifMu.RLock()
				steerFn = h.persistentSteerByName
				h.notifMu.RUnlock()
			}
			if steerFn == nil {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "steer dispatch by name not available"})
				return
			}
			result, err := steerFn(req.Params.Name, req.Params.Message)
			if err != nil {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
				return
			}
			data, _ := json.Marshal(result) //nolint:errcheck // marshal of a local RPC struct
			h.sendResponse(id, json.RawMessage(data), nil)
		}()
		return true

	case "ext/steer_self":
		var req struct {
			Params struct {
				Message string `json:"message"`
				// Kind classifies who authored message. Empty preserves old SDK behavior.
				Kind string `json:"kind,omitempty"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return true
		}
		go func() {
			switch {
			case ctx != nil && ctx.SteerSelfWithKind != nil:
				result, err := ctx.SteerSelfWithKind(req.Params.Message, req.Params.Kind)
				if err != nil {
					h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
					return
				}
				data, _ := json.Marshal(result) //nolint:errcheck // marshal of a local RPC struct
				h.sendResponse(id, json.RawMessage(data), nil)
			case ctx != nil && ctx.SteerSelf != nil:
				if req.Params.Kind != "" {
					utils.LogWithFields(utils.LevelWarn, "extension", "ext/steer_self: kind supplied but context has no kind-aware steer; delivering unclassified", map[string]any{
						"kind": req.Params.Kind,
					})
				}
				result, err := ctx.SteerSelf(req.Params.Message)
				if err != nil {
					h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
					return
				}
				data, _ := json.Marshal(result) //nolint:errcheck // marshal of a local RPC struct
				h.sendResponse(id, json.RawMessage(data), nil)
			default:
				h.notifMu.RLock()
				steerFn := h.persistentSteerSelf
				h.notifMu.RUnlock()
				if steerFn == nil {
					utils.LogWithFields(utils.LevelWarn, "extension", "ext/steer_self: no ctx and no persistent fallback; rejecting", map[string]any{
						"extension": h.name_,
					})
					h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "steer self not available"})
					return
				}
				result, err := steerFn(req.Params.Message, req.Params.Kind)
				if err != nil {
					h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
					return
				}
				data, _ := json.Marshal(result) //nolint:errcheck // marshal of a local RPC struct
				h.sendResponse(id, json.RawMessage(data), nil)
			}
		}()
		return true

	default:
		return false
	}
}

func (h *Host) steerDispatchByID(ctx *Context, id int64, raw []byte) {
	h.handleSteerRPC(ctx, "ext/steer_dispatch", id, raw)
}

func (h *Host) steerDispatchByName(ctx *Context, id int64, raw []byte) {
	h.handleSteerRPC(ctx, "ext/steer_dispatch_by_name", id, raw)
}

func (h *Host) steerSelf(ctx *Context, id int64, raw []byte) {
	h.handleSteerRPC(ctx, "ext/steer_self", id, raw)
}
