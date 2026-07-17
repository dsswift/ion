package backend

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// resolveProviderForRun resolves the LLM provider for a run, applying the
// engine's "fall back to DefaultModel when the requested model is
// unknown" graceful-degradation policy. Returns the resolved provider
// and the (possibly swapped) model id, or nil if the run cannot proceed.
//
// When the provider cannot be resolved AND no fallback is available
// (either because run.cfg is nil or run.cfg.DefaultModel is empty), the
// function emits the existing ErrorEvent{ErrorCode: "invalid_model"} +
// emitError + emitExit and returns nil — telling the caller to abort
// the run. When the empty-model precondition fails (model == ""), it
// emits a distinct ErrorEvent{ErrorCode: "no_model_configured"} with
// actionable text. Both paths log to ~/.ion/engine.log so the decision
// is reconstructible.
//
// When the fallback fires, the function:
//
//  1. Logs the swap at WARN level (existing behaviour, preserved).
//  2. Emits a typed ModelFallbackEvent on the run's normalized stream
//     so consumers can react. The event is a workflow signal — fired
//     once at the swap site, not retained in any snapshot, never
//     duplicated to stream content (TaskCompleteEvent.Result,
//     TextChunkEvent). See CLAUDE.md § "The typed-event corollary"
//     for the rule that prohibits double-surfacing.
//  3. Logs the emission at INFO with the session id so it's grep-able.
//
// Mutates opts.Model in place when the swap happens; that's deliberate —
// the rest of runLoop reads opts.Model for telemetry, hooks, and
// conversation persistence and must see the actual model that ran.
func (b *ApiBackend) resolveProviderForRun(run *activeRun, opts *types.RunOptions) (providers.LlmProvider, string) {
	model := opts.Model
	if model == "" {
		msg := "no model configured: set defaultModel in ~/.ion/engine.json or pass --model. See docs/configuration/engine-json.md."
		utils.Error("ApiBackend", msg)
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
			ErrorMessage: msg,
			ErrorCode:    "no_model_configured",
		}})
		b.emitError(run, fmt.Errorf("%s", msg))
		b.emitExit(run.requestID, intPtr(1), nil, opts.ConversationID)
		return nil, ""
	}

	provider := b.resolveProvider(model)
	if provider == nil && run.cfg != nil && run.cfg.DefaultModel != "" && run.cfg.DefaultModel != model {
		// Graceful degradation: the requested model (e.g. an unrecognized
		// tier alias like "standard") didn't resolve. Fall back to the
		// engine's default model instead of hard-failing.
		//
		// Emit a typed ModelFallbackEvent so consumers (clients, harness
		// extensions) can react. The event is a workflow signal — fired
		// once at the swap site, not retained in any snapshot. Consumers
		// that need sticky UI must project the fact into their own state.
		// We never mutate stream content (TaskCompleteEvent.Result,
		// TextChunkEvent) to communicate this — typed event is the entire
		// signaling surface. See CLAUDE.md § "The typed-event corollary".
		original := model
		utils.LogWithFields(utils.LevelWarn, "backend.runloop", "model not found, falling back to default", map[string]any{
			"model":         model,
			"default_model": run.cfg.DefaultModel,
		})
		model = run.cfg.DefaultModel
		opts.Model = model
		provider = b.resolveProvider(model)
		b.emit(run, types.NormalizedEvent{Data: &types.ModelFallbackEvent{
			RequestedModel: original,
			FallbackModel:  run.cfg.DefaultModel,
			Reason:         "no_provider_found",
		}})
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "model_fallback_emitted", map[string]any{
			"requested":       original,
			"fallback":        run.cfg.DefaultModel,
			"reason":          "no_provider_found",
			"conversation_id": opts.ConversationID,
		})

		// provider.fallback telemetry (family 4d), no-provider-found path. The
		// overload-driven fallback path is emitted from runloop.go's OnFallback
		// closure; this covers the graceful-degradation swap at resolve time.
		if run.cfg.Telemetry != nil {
			// R11: event name is carried by Event.Name; payload.kind removed.
			run.cfg.Telemetry.Event("provider.fallback", map[string]any{
				"requested_model": original,
				"fallback_model":  run.cfg.DefaultModel,
				"reason":          "no_provider_found",
				"hop":             0,
				"turn":            0,
			}, buildTelemCtx(run))
		}
	}
	if provider == nil {
		// No fallback was attempted (or attempted but the default model
		// itself didn't resolve, which is a configuration error). Log
		// whether the fallback was even available so the "no default
		// configured" branch is distinguishable in engine.log from the
		// "default model is unknown" branch.
		if run.cfg == nil || run.cfg.DefaultModel == "" {
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "model_fallback_skipped: reason=no_default_configured", map[string]any{
				"requested":       model,
				"run_cfg_nil":     run.cfg == nil,
				"conversation_id": opts.ConversationID,
			})
		}
		utils.LogWithFields(utils.LevelError, "backend.runloop", "no provider for model", map[string]any{
			"model": model,
		})
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
			ErrorMessage: fmt.Sprintf("no provider found for model %q", model),
			ErrorCode:    "invalid_model",
		}})
		b.emitError(run, fmt.Errorf("no provider found for model %q", model))
		b.emitExit(run.requestID, intPtr(1), nil, opts.ConversationID)
		return nil, ""
	}

	return provider, model
}
