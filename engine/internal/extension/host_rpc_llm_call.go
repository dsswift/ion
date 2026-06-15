package extension

import (
	"context"
	"encoding/json"
	"fmt"

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
		utils.Log("extension", fmt.Sprintf("ext/llm_call: parse error: %v", err))
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	if ctx == nil || ctx.LLMCall == nil {
		utils.Log("extension", "ext/llm_call: no ctx or no LLMCall wired; rejecting")
		h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "llmCall not available outside an active session"})
		return
	}
	utils.Debug("extension", fmt.Sprintf(
		"ext/llm_call: dispatching id=%d model=%s sysLen=%d promptLen=%d jsonMode=%v maxTokens=%d temperatureSet=%v temperature=%v",
		id, req.Params.Model, len(req.Params.System), len(req.Params.Prompt),
		req.Params.JSONMode, req.Params.MaxTokens, req.Params.TemperatureSet, req.Params.Temperature,
	))

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
			utils.Log("extension", fmt.Sprintf("ext/llm_call: failed: %v", err))
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
			return
		}
		data, marshalErr := json.Marshal(result)
		if marshalErr != nil {
			utils.Error("extension", fmt.Sprintf("ext/llm_call: marshal failed: %v", marshalErr))
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: marshalErr.Error()})
			return
		}
		utils.Debug("extension", fmt.Sprintf(
			"ext/llm_call: success contentLen=%d in=%d out=%d cost=%.6f",
			len(result.Content), result.InputTokens, result.OutputTokens, result.Cost,
		))
		h.sendResponse(id, json.RawMessage(data), nil)
	}()
}
