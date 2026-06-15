package backend

import (
	"context"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// maxConsecutiveCompactions caps the number of proactive compactions that
// can fire back-to-back without a successful API response in between. After
// this many attempts the run emits compact_loop_aborted and stops trying so
// it does not burn turns on a conversation that refuses to shrink.
const maxConsecutiveCompactions = 3

// runHookCtx runs fn on a goroutine and races it against ctx cancellation.
// On cancel, returns ctx.Err() and discards the eventual result. The inner
// goroutine continues to completion (it has no way to be cancelled — that's
// why we need this wrapper) but its return value is dropped. Use to bound
// per-tool extension hooks (OnToolCall, OnPermissionRequest, etc.) that are
// implemented by extension subprocesses with no native ctx support.
func runHookCtx[T any](ctx context.Context, fn func() T) (T, error) {
	var zero T
	ch := make(chan T, 1)
	go func() {
		defer func() {
			// Hook callbacks are extension-supplied; recover panics so they
			// can't take down the run. Drop the result on panic.
			_ = recover()
		}()
		ch <- fn()
	}()
	select {
	case v := <-ch:
		return v, nil
	case <-ctx.Done():
		return zero, ctx.Err()
	}
}

// defaultToolTimeout caps how long a single tool call may run. The cap is a
// belt-and-suspenders backstop against tools that ignore ctx; properly
// cooperating tools cancel via gCtx far sooner. Bash has its own much-longer
// inner timeout (long shell commands are legitimate); this cap applies to the
// surrounding goroutine, so a misbehaving Bash subprocess that ignores SIGTERM
// will still let executeTools return.
const defaultToolTimeout = 5 * time.Minute

// toolStallThreshold is how long a tool call runs before a ToolStalledEvent
// is emitted. This is a heuristic to surface tools that may be blocked by
// macOS TCC permission dialogs or stuck on slow operations. The event is
// informational -- it does NOT cancel the tool.
//
// Declared as a var (not const) so tests can shorten it without waiting 30s.
var toolStallThreshold = 30 * time.Second

// resolveContextWindow returns the context-window size (in tokens) to use for
// compaction sizing for the given model. It uses the registry's window only
// when it is a usable positive value; a registry entry that exists but carries
// ContextWindow == 0 (a catalog gap, e.g. openai/gpt-4o-mini routed via
// OpenRouter) would otherwise overwrite the sane default with 0 and collapse
// every compaction (limit=0, budget=0 → truncate to nothing each turn). The
// > 0 guard must live here, at the resolution site, so the clamped value flows
// into AutoCompactTokenLimit and the targetTokens math — not only into
// GetContextUsage's internal clamp.
func resolveContextWindow(model string) int {
	info := providers.GetModelInfo(model)
	if info == nil {
		utils.Warn("ApiBackend", fmt.Sprintf("resolveContextWindow: model=%s window=%d (fallback, model not in registry)", model, conversation.DefaultContext))
		return conversation.DefaultContext
	}
	if info.ContextWindow > 0 {
		utils.Log("ApiBackend", fmt.Sprintf("resolveContextWindow: model=%s window=%d (from registry)", model, info.ContextWindow))
		return info.ContextWindow
	}
	utils.Warn("ApiBackend", fmt.Sprintf("resolveContextWindow: model=%s registry window=0, using default=%d (zero-guard)", model, conversation.DefaultContext))
	return conversation.DefaultContext
}

// handleUnknownStopReason resolves the run loop's `switch stopReason` default
// branch. It distinguishes a provider-signalled "error" stop — which slipped
// past the provider's own *ProviderError conversion (the openai provider now
// returns a *ProviderError for these) — from a genuinely-unknown stop reason.
//
//   - "error": emit an ErrorEvent and exit non-zero, so headless consumers can
//     tell "the model had nothing to say" apart from "the provider failed"
//     instead of receiving a silent exit 0.
//   - anything else: log it and exit 0 (the prior, preserved behavior).
func (b *ApiBackend) handleUnknownStopReason(run *activeRun, conv *conversation.Conversation, stopReason string, turn int) {
	if stopReason == "error" {
		utils.Error("ApiBackend", fmt.Sprintf("stop reason=error reached run loop: runID=%s turn=%d — emitting ErrorEvent + exit 1", run.requestID, turn))
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
			ErrorMessage: "The provider reported an error mid-stream.",
			IsError:      true,
			ErrorCode:    "provider_stream_error",
		}})
		b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
		return
	}
	utils.Log("ApiBackend", fmt.Sprintf("unexpected stop reason: %s (runID=%s turn=%d) — exit 0", stopReason, run.requestID, turn))
	b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
}

// computeCost estimates the USD cost for a turn using the model registry.
func computeCost(model string, usage types.LlmUsage) float64 {
	info := providers.GetModelInfo(model)
	if info == nil {
		return 0
	}
	inputCost := float64(usage.InputTokens) / 1000.0 * info.CostPer1kInput
	outputCost := float64(usage.OutputTokens) / 1000.0 * info.CostPer1kOutput
	return inputCost + outputCost
}

// appendOrGrow ensures the slice is large enough for the given index.
func appendOrGrow(blocks []types.LlmContentBlock, idx int, block types.LlmContentBlock) []types.LlmContentBlock {
	for len(blocks) <= idx {
		blocks = append(blocks, types.LlmContentBlock{})
	}
	blocks[idx] = block
	return blocks
}

func intPtr(v int) *int       { return &v }
func strPtr(v string) *string { return &v }

// buildUserContentBlocks turns a text prompt plus pre-encoded image
// attachments into a structured content-block slice for the user message.
// The text block is emitted first when non-empty; one image block per
// attachment follows, in order. Empty-data attachments are dropped (they
// would otherwise produce a malformed provider request).
func buildUserContentBlocks(prompt string, attachments []types.ImageAttachment) []types.LlmContentBlock {
	blocks := make([]types.LlmContentBlock, 0, len(attachments)+1)
	if prompt != "" {
		blocks = append(blocks, types.LlmContentBlock{Type: "text", Text: prompt})
	}
	for _, a := range attachments {
		if a.Data == "" || a.MediaType == "" {
			continue
		}
		blocks = append(blocks, types.LlmContentBlock{
			Type: "image",
			Source: &types.ImageSource{
				Type:      "base64",
				MediaType: a.MediaType,
				Data:      a.Data,
			},
		})
	}
	if len(blocks) == 0 {
		// All attachments invalid AND prompt empty: emit a placeholder text
		// block so AddUserMessage's blocks branch is well-formed. Must be
		// non-empty — Anthropic rejects cache_control on empty text blocks.
		utils.Debug("ApiBackend", "buildUserContentBlocks: emitting placeholder for empty prompt + invalid attachments")
		blocks = append(blocks, types.LlmContentBlock{Type: "text", Text: "(empty prompt)"})
	}
	return blocks
}
