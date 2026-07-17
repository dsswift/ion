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

	"github.com/dsswift/ion/engine/internal/cost"
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
			utils.LogWithFields(utils.LevelInfo, "session.llm_call", "reject: model empty ( )", map[string]any{"session_key": sa.SessionKey(), "count": len(opts.Prompt)})
			return nil, errors.New("LLMCall: model is required")
		}
		if opts.Prompt == "" {
			utils.LogWithFields(utils.LevelInfo, "session.llm_call", "reject: prompt empty ( )", map[string]any{"session_key": sa.SessionKey(), "model": opts.Model})
			return nil, errors.New("LLMCall: prompt is required")
		}

		// --- Resolve provider via the same registry the agent loop uses ---
		provider := providers.ResolveProvider(opts.Model)
		providerID := ""
		if provider != nil {
			providerID = provider.ID()
		}
		if provider == nil {
			utils.LogWithFields(utils.LevelInfo, "session.llm_call", "reject: no provider for model ( )", map[string]any{"session_key": sa.SessionKey(), "model": opts.Model})
			return nil, fmt.Errorf("LLMCall: no provider registered for model %q", opts.Model)
		}
		utils.LogWithFields(utils.LevelInfo, "session.llm_call", "resolved provider ( )", map[string]any{"session_key": sa.SessionKey(), "model": opts.Model, "provider_i_d": providerID, "j_s_o_n_mode": opts.JSONMode, "max_tokens": opts.MaxTokens, "count": len(opts.System), "count_6": len(opts.Prompt)})

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
		// Forward temperature only when the caller explicitly set it.
		// TemperatureSet disambiguates a deliberate 0 (fully deterministic)
		// from "unset"; without it the omitempty JSON tag on the wire field
		// would erase a real 0. When unset, the provider default applies.
		if opts.TemperatureSet {
			t := opts.Temperature
			streamOpts.Temperature = &t
		}
		// Provider-enforced JSON mode. The provider layer maps this to a
		// request-level switch where one exists (OpenAI-compatible:
		// response_format={"type":"json_object"}); providers without a native
		// switch (Anthropic) ignore it and the flag stays advisory.
		if opts.JSONMode {
			streamOpts.ResponseFormat = "json_object"
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
			utils.LogWithFields(utils.LevelDebug, "session.llm_call", "firing before_provider_request ( )", map[string]any{"session_key": sa.SessionKey(), "provider": info.Provider, "model": info.Model, "message_count": info.MessageCount, "has_system_prompt": info.HasSystemPrompt, "max_tokens": info.MaxTokens})
			// Defensive: a panicking handler must not break the call.
			// Mirrors the agent loop's recovery shape in runloop.go.
			func() {
				defer func() {
					if r := recover(); r != nil {
						utils.LogWithFields(utils.LevelError, "session.llm_call", "before_provider_request handler panicked ( )", map[string]any{"session_key": sa.SessionKey(), "r": r})
					}
				}()
				// FireBeforeProviderRequest builds its own ctx per host;
				// we pass NewExtContext(sa) the same way other call sites
				// do (mirrors dispatch_agent.go's per-fire ctx construction).
				eg.FireBeforeProviderRequest(NewExtContext(sa), info)
			}()
		} else {
			utils.LogWithFields(utils.LevelDebug, "session.llm_call", "no extension group / empty group; skipping before_provider_request ()", map[string]any{"session_key": sa.SessionKey()})
		}

		// --- Drain the provider stream ---
		//
		// Modelled on engine/internal/titling/titling.go which performs
		// the same kind of one-shot streaming-to-text accumulation. We
		// keep token counts from message_start (input tokens) and
		// message_delta usage (output tokens) so the result mirrors
		// what the agent loop reports via UsageData.
		//
		// Derive the call's context from the session cancellation root
		// (sa.RootContext()) rather than context.Background(). This is
		// what makes a session abort cancel an in-flight one-shot: when
		// the user hits Stop, SendAbort cancels the session root, which
		// cancels this ctx, which aborts the provider stream. Before this
		// the llmCall context was orphaned (Background) and a one-shot ran
		// to completion after abort, burning budget and emitting a
		// success engine_llm_call event for work the user cancelled.
		ctx, cancel := context.WithCancel(sa.RootContext())
		defer cancel()

		// Compose the optional per-call context (opts.Ctx) so the call is
		// cancelled if EITHER the session root or the per-call context
		// fires. opts.Ctx is set by the host when a TS-side AbortSignal is
		// threaded into ctx.llmCall({ signal }); the host cancels it via
		// the ext/llm_call_cancel notification. Go has no native "cancel on
		// either of two contexts", so a small watcher goroutine cancels our
		// derived ctx when opts.Ctx fires. The goroutine exits when ctx is
		// done (either source), so it never leaks.
		if opts.Ctx != nil {
			go func(perCall context.Context) {
				select {
				case <-perCall.Done():
					utils.LogWithFields(utils.LevelDebug, "session.llm_call", "per-call context cancelled; cancelling llm_call ( )", map[string]any{"session_key": sa.SessionKey(), "model": opts.Model})
					cancel()
				case <-ctx.Done():
					// Call finished or session root cancelled; nothing to do.
				}
			}(opts.Ctx)
		}

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
				utils.LogWithFields(utils.LevelInfo, "session.llm_call", "provider error ( )", map[string]any{"session_key": sa.SessionKey(), "model": opts.Model, "provider_i_d": providerID, "error": err})
				return nil, fmt.Errorf("LLMCall: provider error: %w", err)
			}
		}

		// Context-cancellation check. A session abort (or per-call cancel)
		// cancels ctx, which ends the provider stream — but the provider may
		// close its channels cleanly without surfacing an error on errc. We
		// must NOT treat that as a successful completion: returning the
		// partial content and emitting a success engine_llm_call event would
		// report work the user cancelled as if it finished. Checking
		// ctx.Err() here is the precise signal — it is non-nil exactly when
		// the context was cancelled or its deadline passed. On cancellation
		// we return an error and emit no engine_llm_call event (the emit is
		// below this guard), matching the documented contract that no
		// observability event fires on failure.
		if cerr := ctx.Err(); cerr != nil {
			utils.LogWithFields(utils.LevelInfo, "session.llm_call", "cancelled ( )", map[string]any{"session_key": sa.SessionKey(), "model": opts.Model, "provider_i_d": providerID, "cerr": cerr, "count": len(content)})
			return nil, fmt.Errorf("LLMCall: cancelled: %w", cerr)
		}

		elapsed := time.Since(start)
		cost := computeLLMCallCost(opts.Model, usage)

		utils.LogWithFields(utils.LevelInfo, "session.llm_call", "completed ( )", map[string]any{"session_key": sa.SessionKey(), "model": opts.Model, "provider_i_d": providerID, "elapsed": elapsed.Milliseconds(), "count": len(content), "input_tokens": usage.InputTokens, "output_tokens": usage.OutputTokens, "cost": cost})

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

// computeLLMCallCost delegates to cost.TurnCost, which provides cache-aware
// pricing. The historical local reimplementation is removed; all callers in
// this package share the same formula as backend.computeCost.
func computeLLMCallCost(model string, usage types.LlmUsage) float64 {
	return cost.TurnCost(model, usage)
}
