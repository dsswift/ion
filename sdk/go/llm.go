// llm.go — one-shot lightweight inference.
//
// A single round-trip to a provider: no tools, no agent loop, no fallback
// chain. This is the primitive for harness-internal extraction,
// classification, and routing prompts that would otherwise bypass Ion entirely
// with direct provider HTTP. Going through the engine keeps them visible to
// the hook surface (notably before_provider_request) and to per-call
// observability (the engine_llm_call event).
//
// # Cancellation
//
// Cancelling the caller's context does more than abandon the wait: the SDK
// sends ext/llm_call_cancel keyed to the in-flight request id, and the engine
// cancels the provider call itself. Without that the provider request would
// run to completion and bill for tokens nobody reads.
package ion

import (
	"context"
	"encoding/json"
	"fmt"
)

// LLMCallOpts configures a one-shot inference.
type LLMCallOpts struct {
	// Model is the model to call. Required. Resolves through the engine's
	// normal provider resolution.
	Model string `json:"model"`
	// System is the system prompt.
	System string `json:"system,omitempty"`
	// Prompt is the user message. Required.
	Prompt string `json:"prompt"`
	// JSONMode asks the provider for JSON output where supported.
	JSONMode bool `json:"jsonMode,omitempty"`
	// MaxTokens caps the response. Zero uses the provider default.
	MaxTokens int `json:"maxTokens,omitempty"`
	// Temperature sets sampling temperature. Pair it with TemperatureSet: a
	// deliberate 0 and an unset value are both the zero value here, and only
	// the flag distinguishes them.
	Temperature float64 `json:"temperature,omitempty"`
	// TemperatureSet marks Temperature as deliberate, so a 0 means
	// deterministic rather than "use the provider default".
	TemperatureSet bool `json:"temperatureSet,omitempty"`
}

// LLMCallResult is a completed inference.
type LLMCallResult struct {
	Content      string  `json:"content"`
	InputTokens  int     `json:"inputTokens"`
	OutputTokens int     `json:"outputTokens"`
	Cost         float64 `json:"cost"`
}

// LLMCall performs one-shot inference.
//
// Cancelling ctx cancels the provider request on the engine side, not just the
// local wait.
func (c *Context) LLMCall(ctx context.Context, opts LLMCallOpts) (LLMCallResult, error) {
	if opts.Model == "" {
		return LLMCallResult{}, fmt.Errorf("ion: LLMCall requires a model")
	}
	if opts.Prompt == "" {
		return LLMCallResult{}, fmt.Errorf("ion: LLMCall requires a prompt")
	}

	id, ch, cleanup, err := c.sdk.transport.callWithID(ctx, "ext/llm_call", opts)
	if err != nil {
		return LLMCallResult{}, err
	}
	defer cleanup()

	select {
	case resp := <-ch:
		if resp.Error != nil {
			c.sdk.logger.Warn("llm call failed", map[string]any{
				"model": opts.Model, "error": resp.Error.Message,
			})
			return LLMCallResult{}, resp.Error
		}
		var out LLMCallResult
		if len(resp.Result) > 0 && string(resp.Result) != "null" {
			if err := json.Unmarshal(resp.Result, &out); err != nil {
				return LLMCallResult{}, fmt.Errorf("ext/llm_call: decode result: %w", err)
			}
		}
		c.sdk.logger.Debug("llm call completed", map[string]any{
			"model": opts.Model, "inputTokens": out.InputTokens, "outputTokens": out.OutputTokens,
		})
		return out, nil

	case <-ctx.Done():
		// Tell the engine to cancel the provider call. Fire-and-forget by
		// design: there is no reply and nothing useful to do if it does not
		// arrive, and the caller is already leaving.
		c.sdk.transport.notify("ext/llm_call_cancel", map[string]any{"requestId": id})
		c.sdk.logger.Debug("llm call cancelled", map[string]any{"model": opts.Model, "requestId": id})
		return LLMCallResult{}, ctx.Err()

	case <-c.sdk.transport.done:
		return LLMCallResult{}, ErrClosed
	}
}
