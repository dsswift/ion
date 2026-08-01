package extension

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

// handleSteerRPC dispatches the steer-family extension RPCs. It returns true
// when it handled the method (sending a response), false when the method is
// not a steer RPC and the caller should continue its own dispatch switch.
//
// Extracted from host_rpc.go to keep that file under the 800-line cap. Both
// RPCs reuse the existing steer channel mechanism via the wired Context
// closures:
//
//   - ext/steer_dispatch: steer a running background CHILD dispatch by its
//     dispatchId (ctx.SteerDispatch → DispatchRegistry.SteerByID).
//   - ext/steer_dispatch_by_name: steer a running background CHILD dispatch
//     by its agent name (ctx.SteerDispatchByName → DispatchRegistry.SteerByName).
//     Name-based peer of ext/steer_dispatch for callers that know the agent
//     name but not the full collision-safe dispatch ID.
//   - ext/steer_self: deliver a message to the run that OWNS the calling
//     context, with the engine choosing steer-vs-send by that run's live
//     state (ctx.SteerSelf). This is the mechanism a harness uses to bubble a
//     background dispatch's completion back to its dispatching agent without
//     polling — a live owning run is steered mid-turn, an idle one receives a
//     fresh prompt.
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
		// Run async: the steer fallback path calls SendPrompt which
		// acquires a write lock on the session manager. Running that
		// synchronously in the readLoop would block all RPC response
		// processing for this host, deadlocking any concurrent
		// callWithTimeout callers.
		go func() {
			var steerFn func(dispatchID, message string) (SteerDispatchResult, error)
			if ctx != nil && ctx.SteerDispatch != nil {
				steerFn = ctx.SteerDispatch
			} else {
				h.notifMu.RLock()
				steerFn = h.persistentSteer
				h.notifMu.RUnlock()
			}
			if steerFn != nil {
				result, err := steerFn(req.Params.DispatchID, req.Params.Message)
				if err != nil {
					h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
					return
				}
				data, _ := json.Marshal(result) //nolint:errcheck // marshal of a local RPC struct
				h.sendResponse(id, json.RawMessage(data), nil)
			} else {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "steer dispatch not available"})
			}
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
		// Run async: same rationale as ext/steer_dispatch above.
		go func() {
			var steerFn func(name, message string) (SteerDispatchResult, error)
			if ctx != nil && ctx.SteerDispatchByName != nil {
				steerFn = ctx.SteerDispatchByName
			} else {
				h.notifMu.RLock()
				steerFn = h.persistentSteerByName
				h.notifMu.RUnlock()
			}
			if steerFn != nil {
				result, err := steerFn(req.Params.Name, req.Params.Message)
				if err != nil {
					h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
					return
				}
				data, _ := json.Marshal(result) //nolint:errcheck // marshal of a local RPC struct
				h.sendResponse(id, json.RawMessage(data), nil)
			} else {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "steer dispatch by name not available"})
			}
		}()
		return true

	case "ext/steer_self":
		var req struct {
			Params struct {
				Message string `json:"message"`
				// Kind classifies who authored the message. Omitted by an SDK
				// that predates the field, which decodes to "" and behaves
				// exactly as before.
				Kind string `json:"kind,omitempty"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return true
		}
		// Run async: same rationale as ext/steer_dispatch above.
		go func() {
			// Prefer the kind-aware wiring so the classification reaches the
			// steer channel and the idle-fallback prompt. Fall back to the
			// kindless form only when the context predates it, so a caller
			// that supplied a kind is never silently downgraded without the
			// log saying so.
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
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "steer self not available"})
			}
		}()
		return true

	default:
		return false
	}
}
