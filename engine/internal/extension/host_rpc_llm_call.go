package extension

import (
	"context"
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

// host_rpc_llm_call.go — the ext/llm_call request handler, extracted from
// host_rpc.go to keep that file under the 800-line cap. Pairs with
// host_llm_call_cancel.go (the per-RPC cancellation registry) and the
// ext/llm_call_cancel notification handled in host_rpc.go.

// handleLLMCallRPC services the ext/llm_call request. One-shot lightweight
// inference: the TS SDK calls this to avoid the cost of dispatch_agent for
// harness-internal classification / extraction / routing prompts. The call
// runs on a goroutine so a slow provider doesn't stall the RPC reader; the
// response goes back through the standard sendResponse path when the call
// completes (or errors).
//
// Cancellation: a per-call context is registered under the RPC id so an
// ext/llm_call_cancel notification (driven by a TS-side AbortSignal) can
// cancel exactly this call. It composes with the session cancellation root
// inside ctx.LLMCall — the call is cancelled if EITHER fires. The inflight
// entry is removed when the goroutine returns (no leak).
func (h *Host) handleLLMCallRPC(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params struct {
			Model          string  `json:"model"`
			System         string  `json:"system,omitempty"`
			Prompt         string  `json:"prompt"`
			JSONMode       bool    `json:"jsonMode,omitempty"`
			MaxTokens      int     `json:"maxTokens,omitempty"`
			Temperature    float64 `json:"temperature,omitempty"`
			TemperatureSet bool    `json:"temperatureSet,omitempty"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		utils.LogWithFields(utils.LevelInfo, "extension", "ext/llm_call: parse error", map[string]any{"error": err})
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	if ctx == nil || ctx.LLMCall == nil {
		utils.Log("extension", "ext/llm_call: no ctx or no LLMCall wired; rejecting")
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "llmCall not available outside an active session"})
		return
	}
	utils.LogWithFields(utils.LevelDebug, "extension", "ext/llm_call: dispatching", map[string]any{"run_id": id, "model": req.Params.Model, "count": len(req.Params.System), "count_3": len(req.Params.Prompt), "j_s_o_n_mode": req.Params.JSONMode, "max_tokens": req.Params.MaxTokens, "temperature_set": req.Params.TemperatureSet, "temperature": req.Params.Temperature})

	// Per-call cancellation context, registered under the RPC id.
	callCtx, callCancel := context.WithCancel(context.Background())
	h.registerInflightLLMCall(id, callCancel)
	go func() {
		defer h.completeInflightLLMCall(id)
		defer callCancel()
		result, err := ctx.LLMCall(LLMCallOpts{
			Model:          req.Params.Model,
			System:         req.Params.System,
			Prompt:         req.Params.Prompt,
			JSONMode:       req.Params.JSONMode,
			MaxTokens:      req.Params.MaxTokens,
			Temperature:    req.Params.Temperature,
			TemperatureSet: req.Params.TemperatureSet,
			Ctx:            callCtx,
		})
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension", "ext/llm_call: failed", map[string]any{"error": err})
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
			return
		}
		data, marshalErr := json.Marshal(result)
		if marshalErr != nil {
			utils.LogWithFields(utils.LevelError, "extension", "ext/llm_call: marshal failed", map[string]any{"error": marshalErr})
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: marshalErr.Error()})
			return
		}
		utils.LogWithFields(utils.LevelDebug, "extension", "ext/llm_call: success", map[string]any{"count": len(result.Content), "input_tokens": result.InputTokens, "output_tokens": result.OutputTokens, "cost": result.Cost})
		h.sendResponse(id, json.RawMessage(data), nil)
	}()
}
