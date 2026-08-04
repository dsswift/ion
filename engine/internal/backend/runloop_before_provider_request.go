package backend

import (
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// runloop_before_provider_request.go holds fireBeforeProviderRequest, the
// before_provider_request extension-hook dispatch extracted from runLoop
// (runloop.go) to keep that file under the file-size cap — same pattern as
// buildRetryConfig (runloop_telemetry.go) and dispatchStopReason
// (runloop_stop_reason.go).

// fireBeforeProviderRequest fires the before_provider_request extension hook
// immediately before the outbound LLM call. Observe-only — handler return
// values are ignored and the agent loop never blocks on this callback. Fires
// on every turn, including fallback hops, so handlers see the real wire
// request shape (post-fallback model, post-sanitization message list). A nil
// callback means no extensions are interested; the conditional is a pure read
// of an immutable struct field, so this is hot-path safe.
func fireBeforeProviderRequest(run *activeRun, hooks RunHooks, provider providers.LlmProvider, streamOpts *types.LlmStreamOptions, turn int) {
	if hooks.OnBeforeProviderRequest == nil {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "OnBeforeProviderRequest: no callback registered, skipping", map[string]any{
			"run_id": run.requestID,
			"turn":   turn,
		})
		return
	}

	providerID := ""
	if provider != nil {
		providerID = provider.ID()
	}
	info := BeforeProviderRequestInfo{
		Provider:        providerID,
		Model:           streamOpts.Model,
		TurnNumber:      turn,
		MessageCount:    len(streamOpts.Messages),
		ToolCount:       len(streamOpts.Tools),
		HasSystemPrompt: streamOpts.System != "",
		MaxTokens:       streamOpts.MaxTokens,
	}
	utils.LogWithFields(utils.LevelDebug, "backend.runloop", "OnBeforeProviderRequest", map[string]any{
		"run_id":     run.requestID,
		"provider":   info.Provider,
		"model":      info.Model,
		"turn":       info.TurnNumber,
		"messages":   info.MessageCount,
		"tools":      info.ToolCount,
		"sys_prompt": info.HasSystemPrompt,
		"max_tokens": info.MaxTokens,
	})
	func() {
		// Defensive: a panicking handler must not crash the agent loop. The
		// hook is observe-only; recover, log, and proceed.
		defer func() {
			if r := recover(); r != nil {
				utils.LogWithFields(utils.LevelError, "backend.runloop", "OnBeforeProviderRequest panicked", map[string]any{
					"run_id": run.requestID,
					"panic":  r,
				})
			}
		}()
		hooks.OnBeforeProviderRequest(run.requestID, info)
	}()
}
