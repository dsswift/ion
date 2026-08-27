package backend

import (
	"context"
	"runtime/debug"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/cost"
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
			// can't take down the run. Log the panic + stack so a hook that
			// silently stops firing is diagnosable instead of vanishing.
			if r := recover(); r != nil {
				utils.LogWithFields(utils.LevelError, "backend.runloop", "extension hook panic recovered", map[string]any{"panic": r, "stack": string(debug.Stack())})
			}
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
// will still let executeTools return. 60 minutes is generous enough that
// legitimate long tools (large builds, multi-step agent dispatches via the
// extension dispatch_* tools) complete without hitting it, while still
// bounding a truly wedged tool. Kept equal to TimeoutsConfig.ToolDefault()'s
// compiled default so behavior is identical whether or not a Timeouts block is
// configured (runloop_tools.go reads this const, then overrides with the
// configured value when present).
const defaultToolTimeout = 60 * time.Minute

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
		utils.LogWithFields(utils.LevelWarn, "backend.runloop", "resolveContextWindow: (fallback, model not in registry)", map[string]any{
			"model":  model,
			"window": conversation.DefaultContext,
		})
		return conversation.DefaultContext
	}
	if info.ContextWindow > 0 {
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "resolveContextWindow: (from registry)", map[string]any{
			"model":  model,
			"window": info.ContextWindow,
		})
		return info.ContextWindow
	}
	utils.LogWithFields(utils.LevelWarn, "backend.runloop", "resolveContextWindow: registry window=0, using (zero-guard)", map[string]any{
		"model":   model,
		"default": conversation.DefaultContext,
	})
	return conversation.DefaultContext
}

// resolveRunContextCapacity resolves one model-aware capacity value for all
// run-loop decisions. This keeps the proactive compaction threshold aligned
// with prompt admission and context status reporting.
func resolveRunContextCapacity(model string, maxTokens int) conversation.ContextCapacity {
	contextWindow := resolveContextWindow(model)
	capacity := conversation.ResolveModelContextCapacity(contextWindow, maxTokens, providers.GetModelInfo(model))
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "resolved run context capacity", map[string]any{
		"model": model, "context_window": capacity.RawLimit,
		"effective_limit": capacity.EffectiveLimit, "output_reserve": capacity.OutputReserve,
		"summary_reserve": capacity.SummaryReserve,
	})
	return capacity
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
		utils.LogWithFields(utils.LevelError, "backend.runloop", "stop reason=error reached run loop: — emitting ErrorEvent + exit 1", map[string]any{
			"run_id": run.requestID,
			"turn":   turn,
		})
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
			ErrorMessage: "The provider reported an error mid-stream.",
			IsError:      true,
			ErrorCode:    "provider_stream_error",
		}})
		b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
		return
	}
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "unexpected stop reason: — exit 0", map[string]any{
		"stop_reason": stopReason,
		"run_id":      run.requestID,
		"turn":        turn,
	})
	b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
}

// computeCost estimates the USD cost for a turn using the centralized
// cache-aware cost calculator. Delegates to cost.TurnCost, which accounts for
// cache-creation, cache-read, and regular input tokens at their respective
// per-model rates (with fallbacks for models that lack explicit cache pricing).
func computeCost(model string, usage types.LlmUsage) float64 {
	return cost.TurnCost(model, usage)
}

// appendOrGrow ensures the slice is large enough for the given index.
func appendOrGrow(blocks []types.LlmContentBlock, idx int, block types.LlmContentBlock) []types.LlmContentBlock {
	for len(blocks) <= idx {
		blocks = append(blocks, types.LlmContentBlock{})
	}
	blocks[idx] = block
	return blocks
}

func intPtr(v int) *int { return &v }

// cumulativeUsage snapshots the run's cumulative token counters into a
// UsageData suitable for TaskCompleteEvent. Each field is a fresh pointer
// so the event payload is independent of the run struct's lifetime.
func cumulativeUsage(run *activeRun) types.UsageData {
	return types.UsageData{
		InputTokens:              intPtr(run.cumulativeInputTokens),
		OutputTokens:             intPtr(run.cumulativeOutputTokens),
		CacheReadInputTokens:     intPtr(run.cumulativeCacheReadTokens),
		CacheCreationInputTokens: intPtr(run.cumulativeCacheCreateTokens),
	}
}
func strPtr(v string) *string { return &v }

// buildUserContentBlocks turns a text prompt plus pre-encoded image and
// document attachments into a structured content-block slice for the user
// message. The text block is emitted first when non-empty; one content block
// per attachment follows, in order.
//
// Media type dispatch:
//   - "image/*"         — native image block (base64 source)
//   - "application/pdf" — native document block (base64 source); matches
//     the document-block path in buildCliUserContent so API-key and CLI-key
//     consumers see the same behavior when a remote client sends a PDF over
//     the wire (#271)
//
// Empty-data or empty-mediatype attachments are dropped (they would produce a
// malformed provider request). Any unrecognised media type is silently skipped
// (the corresponding marker, if any, stays for the Read-tool fallback).
func buildUserContentBlocks(prompt string, attachments []types.ImageAttachment) []types.LlmContentBlock {
	blocks := make([]types.LlmContentBlock, 0, len(attachments)+1)
	if prompt != "" {
		blocks = append(blocks, types.LlmContentBlock{Type: "text", Text: prompt})
	}
	for _, a := range attachments {
		if a.Data == "" || a.MediaType == "" {
			utils.LogWithFields(utils.LevelWarn, "ApiBackend", "buildUserContentBlocks: dropping attachment with empty data or media type", map[string]any{"mimeType": a.MediaType})
			continue
		}
		contentHash := a.ContentHash
		if strings.HasPrefix(a.MediaType, "image/") && contentHash == "" {
			var hashErr error
			contentHash, hashErr = conversation.ContentHashFromBase64(a.Data)
			if hashErr != nil {
				// Preserve the established attachment pass-through contract. Providers
				// own final base64 validation; omitting an identity is safer than
				// dropping a caller's image because a legacy/test payload is malformed.
				utils.LogWithFields(utils.LevelDebug, "ApiBackend", "buildUserContentBlocks: image hash unavailable", map[string]any{
					"mimeType": a.MediaType,
					"path":     a.Path,
					"error":    utils.ErrStr(hashErr),
				})
				contentHash = ""
			}
		}
		switch {
		case a.MediaType == "application/pdf":
			blocks = append(blocks, types.LlmContentBlock{
				Type: "document",
				Source: &types.ImageSource{
					Type:        "base64",
					MediaType:   "application/pdf",
					Data:        a.Data,
					ContentHash: contentHash,
				},
			})
		case strings.HasPrefix(a.MediaType, "image/"):
			blocks = append(blocks, types.LlmContentBlock{
				Type: "image",
				Source: &types.ImageSource{
					Type:        "base64",
					MediaType:   a.MediaType,
					Data:        a.Data,
					ContentHash: contentHash,
				},
			})
		default:
			// Unknown media type: skip; the marker (if any) remains in the
			// prompt for the Read-tool fallback to handle.
			utils.LogWithFields(utils.LevelDebug, "ApiBackend", "buildUserContentBlocks: skipping unknown media type", map[string]any{
				"media_type": a.MediaType,
				"path":       a.Path,
			})
		}
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

// AppendInboundUserMessage appends the inbound user turn to the conversation,
// handling the four shapes the prompt can take:
//
//   - Resolved slash command (opts.ResolvedSlashCommand set): opts.Prompt is the
//     EXPANDED template body — the LLM sees that — but the persisted/displayed
//     user turn must be the RAW invocation the user typed, so consumers render
//     the command pill and the invocation survives reload.
//     AddUserMessageWithInvocation writes the expansion to conv.Messages and the
//     raw invocation to the tree entry.
//   - Client display text (opts.DisplayPrompt set): opts.Prompt remains what the
//     model sees, while the persisted entry contains only the client-owned
//     rendering. This keeps instructions for the model out of structured cards.
//   - Image attachments (opts.Attachments non-empty): build a structured content
//     block list so the provider sends them as native multimodal content
//     (Anthropic image blocks, OpenAI image_url, Gemini inlineData, Bedrock image
//     content). The engine has no opinion on any client-side marker syntax inside
//     opts.Prompt — bytes ride in opts.Attachments.
//   - Plain text: opts.Prompt verbatim.
//
// Slash expansion and image attachments are mutually exclusive: a resolved slash
// command carries no client image attachments.
//
// The injection KIND is not one of these shapes and does not compete with them.
// It is stamped onto whichever shape ran (see appendInboundUserEntry), because
// a machine-authored turn can legitimately carry any of them — run recovery
// replays the interrupted run's attachments alongside its engine-authored
// continuation prompt.
//
// Returns the *SessionEntry that the underlying AppendEntry produced (the
// display/tree entry for this user turn). Returns nil when no tree entry was
// written (conv.Entries == nil). The caller currently appends-and-persists
// without consuming the entry; the return is retained for callers that need
// the tree entry id.
//
// Extracted from RunAgentLoop to keep runloop.go under the file-size cap.
// AppendInboundUserMessage is exported for session-owned pre-persistence. It
// must remain the only path deciding how a RunOptions prompt becomes a durable
// user entry, otherwise recovery can lose attachment blocks or provenance.
func AppendInboundUserMessage(conv *conversation.Conversation, opts *types.RunOptions) *conversation.SessionEntry {
	// Duplicate-turn sentinel: a user turn byte-identical to the current leaf
	// means the same input was dispatched twice (e.g. a client re-submitting
	// after a stop/restart recovery — the forensic case behind this check was
	// a slash command persisted twice, 15s apart, with no assistant turn
	// between). The engine appends faithfully — suppressing a user turn is
	// policy, which the engine does not own — but says so loudly so the
	// double-dispatching client is identifiable from logs alone.
	if inboundDuplicatesLeaf(conv, opts) {
		utils.LogWithFields(utils.LevelWarn, "backend.runloop", "append: user turn duplicates current leaf", map[string]any{
			"conversation_id": conv.ID,
			"leaf_id":         conversation.CurrentLeafID(conv),
			"content_len":     len(opts.Prompt),
			"slash_command":   opts.ResolvedSlashCommand,
		})
	}

	entry := appendInboundUserEntry(conv, opts)
	// Independent of which append shape ran: a degraded steer needs its marker
	// whether or not it carried a kind. A human steering an idle run degrades
	// with an EMPTY kind, so keying this off the kind-bearing arm would have
	// silently skipped exactly that case.
	appendDegradedSteerMarker(conv, opts)
	return entry
}

// appendInboundUserEntry writes the user turn itself, choosing the append shape
// from the prompt's provenance. Split from appendInboundUserMessage so the
// degraded-steer marker applies to every shape rather than only the
// kind-bearing one.
//
// The switch selects CONTENT SHAPE only. An injection kind is orthogonal to
// shape and is stamped afterwards by ClassifyEntry, so it reaches the persisted
// entry regardless of which arm ran. It used to be a competing arm sitting
// last, which meant a classified injection that also carried attachments or a
// slash expansion took the earlier arm and lost its classification entirely.
// Clients suppress machine-authored turns on exactly that classification, so
// the loss put engine steering messages into the user's transcript on reload.
func appendInboundUserEntry(conv *conversation.Conversation, opts *types.RunOptions) *conversation.SessionEntry {
	var entry *conversation.SessionEntry
	switch {
	case opts.ResolvedSlashCommand != "":
		entry = conversation.AddUserMessageWithInvocation(conv, opts.Prompt, conversation.SlashInvocation{
			Command:        opts.ResolvedSlashCommand,
			Args:           opts.ResolvedSlashArgs,
			Source:         opts.ResolvedSlashSource,
			ModelAlias:     opts.ResolvedSlashModelAlias,
			ModelEffective: opts.ResolvedSlashModelEffective,
			Frontmatter:    opts.ResolvedSlashFrontmatter,
		})
	case opts.DisplayPrompt != "":
		llmContent := any(opts.Prompt)
		displayContent := any(opts.DisplayPrompt)
		if len(opts.Attachments) > 0 {
			llmContent = buildUserContentBlocks(opts.Prompt, opts.Attachments)
			displayContent = buildUserContentBlocks(opts.DisplayPrompt, opts.Attachments)
		}
		entry = conversation.AddUserMessageWithDisplay(conv, llmContent, displayContent)
	case len(opts.Attachments) > 0:
		entry = conversation.AddUserMessage(conv, buildUserContentBlocks(opts.Prompt, opts.Attachments))
	case opts.BackgroundWork != nil:
		entry = conversation.AddUserMessageWithBackgroundWork(conv, opts.Prompt, *opts.BackgroundWork)
	case opts.InjectionKind != "":
		// Engine-injected prompt with a semantic classification (e.g.
		// "agent_completion" for a dispatch callback) and no other shape
		// modifier. ClassifyEntry below would stamp the kind anyway; this arm
		// remains so the plain classified injection keeps its single-call
		// construction path.
		entry = conversation.AddUserMessageWithKind(conv, opts.Prompt, opts.InjectionKind)
	default:
		entry = conversation.AddUserMessage(conv, opts.Prompt)
	}

	// Stamp the classification onto whichever shape ran. A no-op for the two
	// arms that already carry a kind (the kind arm above, and background work,
	// whose payload kind is authoritative for its own delivery).
	conversation.ClassifyEntry(entry, opts.InjectionKind)
	conversation.SetImplementationPhase(entry, opts.ImplementationPhase)

	if opts.DeliveryID != "" && entry != nil {
		if md, ok := entry.Data.(conversation.MessageData); ok {
			md.DeliveryIDs = append(md.DeliveryIDs, opts.DeliveryID)
			entry.Data = md
		}
	}
	return entry
}

// appendDegradedSteerMarker persists the steer marker for a ctx.steerSelf
// delivery that could not steer a live run and became a fresh prompt instead.
//
// drainSteer writes this same marker when the steer DOES reach a live run
// (runloop_steer.go). Writing it here too is what makes the two delivery paths
// agree: the signal is identical, only the transport differed, so a consumer
// that renders a divider from the marker renders one either way. Without it a
// degraded machine turn is suppressed with no trace, and an operator sees a
// tool sweep begin with nothing in the transcript explaining why.
//
// Keyed on opts.SteerDegraded rather than on any injection kind. The kind says
// who authored the turn; degradation says how it arrived, and both are
// independently true — see the field comment on types.RunOptions.SteerDegraded.
//
// The marker rides the caller's existing Save (see RunAgentLoop), so this adds
// no write.
func appendDegradedSteerMarker(conv *conversation.Conversation, opts *types.RunOptions) {
	if !opts.SteerDegraded || conv.Entries == nil {
		return
	}
	conversation.AppendEntry(conv, conversation.EntrySteerMarker, conversation.SteerMarkerData{
		MessageLength: len(opts.Prompt),
	})
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "append: persisted steer marker for degraded steer delivery", map[string]any{
		"conversation_id": conv.ID,
		"count":           len(opts.Prompt),
		"injection_kind":  opts.InjectionKind,
	})
}

// inboundDuplicatesLeaf reports whether the inbound user turn is
// byte-identical to the current leaf entry's user content — the signature of
// a double dispatch. Compares the DISPLAY content (raw slash invocation when
// resolved, prompt text otherwise), because that is what the tree persists.
func inboundDuplicatesLeaf(conv *conversation.Conversation, opts *types.RunOptions) bool {
	display := opts.Prompt
	if opts.DisplayPrompt != "" {
		display = opts.DisplayPrompt
	}
	if opts.ResolvedSlashCommand != "" {
		display = opts.ResolvedSlashCommand
		if opts.ResolvedSlashArgs != "" {
			display = opts.ResolvedSlashCommand + " " + opts.ResolvedSlashArgs
		}
	}
	return display != "" && display == conversation.LeafUserText(conv)
}
