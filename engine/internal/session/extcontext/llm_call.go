// Package extcontext — ctx.LLMCall implementation.
//
// ctx.LLMCall is the lightweight one-shot inference primitive exposed to
// extension authors. It exists to give the harness a way to fire model
// calls for internal classification / extraction / routing without paying
// the cost of a full ctx.DispatchAgent (which spins up a child backend,
// runs the agent loop, fires the full hook chain, and wires a tool
// registry).
//
// Contract:
//
//   - Single round-trip through the provider's streaming API. No tools.
//     No agent loop. No fallback chain. No retry.
//   - Fires the before_provider_request hook exactly once, in observe-only
//     mode (matching the agent-loop path), so handlers see uniform telemetry
//     across both call paths.
//   - Emits exactly one engine_llm_call event on success, carrying
//     model / provider / latency / tokens / cost / jsonMode. Never carries
//     prompt or response content.
//   - Returns (nil, error) on every failure path. No engine_llm_call event
//     fires on errors. Caller decides whether to surface a harness-level
//     event for the failure.
//
// Why not just call providers.LlmProvider.Stream directly from the harness?
// Because Ion-side observability (before_provider_request) and uniform cost
// telemetry are first-class engine concerns: a harness that bypasses them
// to talk to providers directly diverges from every other Ion code path
// and leaves a blind spot in the trace.
package extcontext

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// BuildLLMCallFunc returns the LLMCall closure that performs a one-shot
// inference call. The returned closure captures the SessionAccessor so it
// can resolve providers, fire before_provider_request, and emit
// engine_llm_call on the session's emit fan-out.
//
// nil is never returned — callers can wire the closure unconditionally; the
// closure itself handles the "no provider" / "no model" cases by returning
// an error.
func BuildLLMCallFunc(sa SessionAccessor) func(extension.LLMCallOpts) (*extension.LLMCallResult, error) {
	return func(opts extension.LLMCallOpts) (*extension.LLMCallResult, error) {
		start := time.Now()

		// --- Validate inputs ---
		// We log both sides of every validation branch so a developer
		// reconstructing a failed call from logs alone can see exactly
		// which precondition tripped.
		if opts.Model == "" {
			utils.Log("LLMCall", fmt.Sprintf(
				"reject: model empty (sessionKey=%s promptLen=%d)",
				sa.SessionKey(), len(opts.Prompt),
			))
			return nil, errors.New("LLMCall: model is required")
		}
		if opts.Prompt == "" {
			utils.Log("LLMCall", fmt.Sprintf(
				"reject: prompt empty (sessionKey=%s model=%s)",
				sa.SessionKey(), opts.Model,
			))
			return nil, errors.New("LLMCall: prompt is required")
		}

		// --- Resolve provider via the same registry the agent loop uses ---
		provider := providers.ResolveProvider(opts.Model)
		providerID := ""
		if provider != nil {
			providerID = provider.ID()
		}
		if provider == nil {
			utils.Log("LLMCall", fmt.Sprintf(
				"reject: no provider for model (sessionKey=%s model=%s)",
				sa.SessionKey(), opts.Model,
			))
			return nil, fmt.Errorf("LLMCall: no provider registered for model %q", opts.Model)
		}
		utils.Log("LLMCall", fmt.Sprintf(
			"resolved provider (sessionKey=%s model=%s provider=%s jsonMode=%v maxTokens=%d sysLen=%d promptLen=%d)",
			sa.SessionKey(), opts.Model, providerID, opts.JSONMode, opts.MaxTokens,
			len(opts.System), len(opts.Prompt),
		))

		// --- Build provider stream options ---
		messages := []types.LlmMessage{
			{Role: "user", Content: opts.Prompt},
		}
		streamOpts := types.LlmStreamOptions{
			Model:     opts.Model,
			System:    opts.System,
			Messages:  messages,
			MaxTokens: opts.MaxTokens,
		}

		// --- Fire before_provider_request (observe-only) ---
		//
		// Fan out to every extension host with the same shape the agent
		// loop emits. This is the consistency-over-cost decision: handlers
		// that count outbound calls or tag telemetry must see LLMCall
		// traffic alongside agent-loop traffic, otherwise observability
		// reports are silently wrong.
		//
		// MessageCount=1, ToolCount=0, TurnNumber=0 are the canonical
		// "this is a one-shot, not a turn in an ongoing agent loop"
		// signal. Handlers can distinguish LLMCall from a turn-0 agent
		// dispatch by inspecting MessageCount.
		if eg := sa.ExtGroup(); eg != nil && !eg.IsEmpty() {
			info := extension.BeforeProviderRequestInfo{
				Provider:        providerID,
				Model:           streamOpts.Model,
				TurnNumber:      0,
				MessageCount:    len(streamOpts.Messages),
				ToolCount:       0,
				HasSystemPrompt: streamOpts.System != "",
				MaxTokens:       streamOpts.MaxTokens,
			}
			utils.Debug("LLMCall", fmt.Sprintf(
				"firing before_provider_request (sessionKey=%s provider=%s model=%s msgs=%d sysPrompt=%v maxTokens=%d)",
				sa.SessionKey(), info.Provider, info.Model, info.MessageCount,
				info.HasSystemPrompt, info.MaxTokens,
			))
			// Defensive: a panicking handler must not break the call.
			// Mirrors the agent loop's recovery shape in runloop.go.
			func() {
				defer func() {
					if r := recover(); r != nil {
						utils.Error("LLMCall", fmt.Sprintf(
							"before_provider_request handler panicked (sessionKey=%s panic=%v)",
							sa.SessionKey(), r,
						))
					}
				}()
				// FireBeforeProviderRequest builds its own ctx per host;
				// we pass NewExtContext(sa) the same way other call sites
				// do (mirrors dispatch_agent.go's per-fire ctx construction).
				eg.FireBeforeProviderRequest(NewExtContext(sa), info)
			}()
		} else {
			utils.Debug("LLMCall", fmt.Sprintf(
				"no extension group / empty group; skipping before_provider_request (sessionKey=%s)",
				sa.SessionKey(),
			))
		}

		// --- Drain the provider stream ---
		//
		// Modelled on engine/internal/titling/titling.go which performs
		// the same kind of one-shot streaming-to-text accumulation. We
		// keep token counts from message_start (input tokens) and
		// message_delta usage (output tokens) so the result mirrors
		// what the agent loop reports via UsageData.
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		events, errc := provider.Stream(ctx, streamOpts)

		var content []byte
		var usage types.LlmUsage
		for ev := range events {
			// message_start carries input-token count and any cache reads.
			if ev.MessageInfo != nil {
				usage.InputTokens = ev.MessageInfo.Usage.InputTokens
				usage.CacheReadInputTokens = ev.MessageInfo.Usage.CacheReadInputTokens
				usage.CacheCreationInputTokens = ev.MessageInfo.Usage.CacheCreationInputTokens
			}
			// content_block_delta text accumulates into the response body.
			if ev.Delta != nil && ev.Delta.Text != "" {
				content = append(content, ev.Delta.Text...)
			}
			// message_delta usage carries output-token counts.
			if ev.DeltaUsage != nil {
				usage.OutputTokens = ev.DeltaUsage.OutputTokens
			}
		}
		if errc != nil {
			if err := <-errc; err != nil {
				utils.Log("LLMCall", fmt.Sprintf(
					"provider error (sessionKey=%s model=%s provider=%s err=%v)",
					sa.SessionKey(), opts.Model, providerID, err,
				))
				return nil, fmt.Errorf("LLMCall: provider error: %w", err)
			}
		}

		elapsed := time.Since(start)
		cost := computeLLMCallCost(opts.Model, usage)

		utils.Log("LLMCall", fmt.Sprintf(
			"completed (sessionKey=%s model=%s provider=%s latencyMs=%d contentLen=%d in=%d out=%d cost=%.6f)",
			sa.SessionKey(), opts.Model, providerID, elapsed.Milliseconds(),
			len(content), usage.InputTokens, usage.OutputTokens, cost,
		))

		// --- Emit engine_llm_call (observability) ---
		//
		// Snapshot semantics don't apply here — engine_llm_call is a
		// per-event observation, not a registry update. Consumers
		// accumulate / aggregate as they wish.
		sa.Emit(types.EngineEvent{
			Type:                "engine_llm_call",
			LlmCallModel:        opts.Model,
			LlmCallProvider:     providerID,
			LlmCallLatencyMs:    elapsed.Milliseconds(),
			LlmCallInputTokens:  usage.InputTokens,
			LlmCallOutputTokens: usage.OutputTokens,
			LlmCallCost:         cost,
			LlmCallJsonMode:     opts.JSONMode,
		})

		return &extension.LLMCallResult{
			Content:      string(content),
			InputTokens:  usage.InputTokens,
			OutputTokens: usage.OutputTokens,
			Cost:         cost,
		}, nil
	}
}

// computeLLMCallCost mirrors backend.computeCost for the LLMCall path. The
// backend's computeCost is unexported (and lives in a package we cannot
// import from here without creating a cycle), so we recompute via the
// same providers.GetModelInfo lookup. Both functions must move in lockstep
// if the cost formula ever changes.
//
// Returns 0 when the model is not in the registry (e.g. custom models
// without cost metadata) — the consumer treats 0 as "unknown" rather than
// "free", which is the same behaviour the agent-loop path exhibits.
func computeLLMCallCost(model string, usage types.LlmUsage) float64 {
	info := providers.GetModelInfo(model)
	if info == nil {
		return 0
	}
	inputCost := float64(usage.InputTokens) / 1000.0 * info.CostPer1kInput
	outputCost := float64(usage.OutputTokens) / 1000.0 * info.CostPer1kOutput
	return inputCost + outputCost
}
