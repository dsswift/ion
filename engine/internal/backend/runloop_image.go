package backend

import (
	"context"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/cost"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// runImageLoop handles a run whose selected model is an image-generation model
// (ModelKind == "image"). It replaces the full agent loop for these models
// because image APIs have a completely different wire shape: single prompt in,
// image bytes out — no conversation history, no tools, no streaming.
//
// Only opts.Prompt is sent to the image API. Conversation history is NOT
// forwarded; the plan document (docs/features/image-models.md) explains the
// single-prompt semantics and the UI disclosure the desktop renders when an
// image model is selected.
//
// The generated image IS persisted to the conversation tree (via
// saveProviderImage) so that switching back to a chat model gives the LLM
// access to the image inline. The sequence emitted on success:
//
//  1. TextChunkEvent carrying the provider-revised prompt (DALL-E 3 always
//     returns one; other models may not). This creates the assistant-message
//     slot that the image attachment renders under.
//  2. ImageContentEvent per returned image (Source="provider").
//  3. TaskCompleteEvent with NumTurns=1.
func (b *ApiBackend) runImageLoop(ctx context.Context, run *activeRun, opts types.RunOptions) {
	model := opts.Model
	utils.LogWithFields(utils.LevelInfo, "backend.image", "image run start", map[string]any{
		"run_id": run.requestID,
		"model":  model,
	})

	start := time.Now()

	// Resolve conversation so generated images land in the right images/ dir.
	conv, convErr := loadOrCreateConversation(opts, model)
	if convErr != nil {
		msg := fmt.Sprintf("Failed to load conversation %s: %v. Your conversation history is safe on disk — please retry.", opts.ConversationID, convErr)
		utils.Error("backend.image", msg)
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
			ErrorMessage: msg,
			ErrorCode:    "conversation_load_failed",
		}})
		b.emitError(run, fmt.Errorf("%s", msg))
		b.emitExit(run.requestID, intPtr(1), nil, opts.ConversationID)
		return
	}
	run.conv = conv

	// Persist the user prompt turn so the conversation reflects what was asked.
	appendInboundUserMessage(conv, &opts)
	if saveErr := conversation.Save(conv, ""); saveErr != nil {
		utils.LogWithFields(utils.LevelInfo, "backend.image", "failed to save conversation after user message", map[string]any{
			"run_id": run.requestID,
			"error":  utils.ErrStr(saveErr),
		})
	}

	// Emit session_init so downstream consumers (desktop, iOS) can key on
	// the conversation ID immediately, matching the chat-loop behavior.
	b.emit(run, types.NormalizedEvent{Data: &types.SessionInitEvent{
		SessionID: conv.ID,
	}})

	// Verify a direct API key is resolvable. Image generation APIs cannot be
	// proxied through a delegated CLI (Codex/ChatGPT subscription). When only
	// a CLI-backed credential exists, fail fast with an actionable message.
	imageProviderID := "openai" // all current image models are OpenAI
	if info := providers.GetModelInfo(model); info != nil && info.ProviderID != "" {
		imageProviderID = info.ProviderID
	}

	apiKey := ""
	if b.authResolver != nil {
		var err error
		apiKey, err = b.authResolver.ResolveKey(imageProviderID)
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "backend.image", "auth resolver error", map[string]any{
				"run_id":   run.requestID,
				"model":    model,
				"provider": imageProviderID,
				"error":    utils.ErrStr(err),
			})
		}
	}
	if apiKey == "" {
		// Fall back to the registry (set by the server at startup from env/keychain).
		apiKey = providers.GetProviderKey(imageProviderID)
	}
	if apiKey == "" {
		msg := fmt.Sprintf(
			"%s requires a direct %s API key; image generation is not available via a CLI subscription path. Add an API key in Settings → Providers.",
			model, imageProviderID,
		)
		utils.LogWithFields(utils.LevelError, "backend.image", "no api key for image provider", map[string]any{
			"run_id":   run.requestID,
			"model":    model,
			"provider": imageProviderID,
		})
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
			ErrorMessage: msg,
			ErrorCode:    "image_no_api_key",
		}})
		b.emitError(run, fmt.Errorf("%s", msg))
		b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
		return
	}

	// Resolve the image provider implementation.
	imageProvider := providers.ResolveImageProvider(model)
	if imageProvider == nil {
		msg := fmt.Sprintf("no image provider registered for model %q", model)
		utils.LogWithFields(utils.LevelError, "backend.image", "no image provider", map[string]any{
			"run_id": run.requestID,
			"model":  model,
		})
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
			ErrorMessage: msg,
			ErrorCode:    "image_no_provider",
		}})
		b.emitError(run, fmt.Errorf("%s", msg))
		b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
		return
	}

	// Set the resolved API key on the provider registry so the image provider
	// can pick it up via GetProviderKey at request time.
	providers.SetProviderKey(imageProviderID, apiKey)

	utils.LogWithFields(utils.LevelInfo, "backend.image", "calling image provider", map[string]any{
		"run_id":   run.requestID,
		"model":    model,
		"provider": imageProvider.ID(),
		"prompt":   truncatePrompt(opts.Prompt, 80),
	})

	results, err := imageProvider.Generate(ctx, types.ImageGenerateOptions{
		Model:  model,
		Prompt: opts.Prompt,
	})
	if err != nil {
		utils.LogWithFields(utils.LevelError, "backend.image", "image generation failed", map[string]any{
			"run_id": run.requestID,
			"model":  model,
			"error":  utils.ErrStr(err),
		})
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
			ErrorMessage: fmt.Sprintf("Image generation failed: %v", err),
			ErrorCode:    "image_generation_failed",
		}})
		b.emitError(run, err)
		b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
		return
	}

	if len(results) == 0 {
		msg := "image generation returned no results"
		utils.LogWithFields(utils.LevelError, "backend.image", msg, map[string]any{"run_id": run.requestID, "model": model})
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
			ErrorMessage: msg,
			ErrorCode:    "image_empty_response",
		}})
		b.emitError(run, fmt.Errorf("%s", msg))
		b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
		return
	}

	// Emit the revised prompt as a text chunk before images so the assistant
	// message slot exists for image attachment in clients that group images
	// under the preceding text block.
	revisedPrompt := results[0].RevisedPrompt
	if revisedPrompt != "" {
		b.emit(run, types.NormalizedEvent{Data: &types.TextChunkEvent{Text: revisedPrompt}})
	}

	// Save and emit each generated image, and build the assistant content
	// blocks that persist the turn. The image block carries the base64 bytes
	// in Source — the durable record for historical reload (the live
	// ImageContentEvent is NOT persisted; flattenEntries re-derives the
	// content-addressed path from these bytes, same as tool-result images).
	var persistBlocks []types.LlmContentBlock
	if revisedPrompt != "" {
		persistBlocks = append(persistBlocks, types.LlmContentBlock{Type: "text", Text: revisedPrompt})
	}
	for i, result := range results {
		path := b.saveProviderImage(run, result.MediaType, result.Data)
		if path == "" {
			utils.LogWithFields(utils.LevelError, "backend.image", "failed to save image, skipping", map[string]any{
				"run_id": run.requestID,
				"model":  model,
				"index":  i,
			})
			continue
		}
		persistBlocks = append(persistBlocks, types.LlmContentBlock{
			Type: "image",
			Source: &types.ImageSource{
				Type:      "base64",
				MediaType: result.MediaType,
				Data:      result.Data,
			},
		})
		b.emit(run, types.NormalizedEvent{Data: &types.ImageContentEvent{
			Path:      path,
			MediaType: result.MediaType,
			Source:    "provider",
		}})
		utils.LogWithFields(utils.LevelInfo, "backend.image", "image emitted", map[string]any{
			"run_id": run.requestID,
			"model":  model,
			"index":  i,
			"path":   path,
		})
	}

	// Persist the assistant turn (revised prompt text + image blocks) so the
	// conversation survives reload. Without this the tree holds only the user
	// prompt and the image vanishes from history the moment the client
	// reloads the conversation file.
	if len(persistBlocks) > 0 {
		conversation.AddAssistantMessage(conv, persistBlocks, types.LlmUsage{})
		if saveErr := conversation.Save(conv, ""); saveErr != nil {
			utils.LogWithFields(utils.LevelError, "backend.image", "failed to save conversation after assistant image message", map[string]any{
				"run_id": run.requestID,
				"error":  utils.ErrStr(saveErr),
			})
		}
	}

	durationMs := time.Since(start).Milliseconds()
	b.emit(run, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
		Reason: types.TaskCompletionReasonNormal,
		Result: revisedPrompt,
		// Per-image billing (e.g. FLUX on Azure Foundry): images × the model's
		// CostPerImage rate. Zero for per-token image models / unknown pricing.
		CostUsd:    cost.ImageCost(model, len(results)),
		DurationMs: durationMs,
		NumTurns:   1,
		SessionID:  conv.ID,
	}})
	b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
	utils.LogWithFields(utils.LevelInfo, "backend.image", "image run complete", map[string]any{
		"run_id":      run.requestID,
		"model":       model,
		"duration_ms": durationMs,
		"images":      len(results),
	})
}

// truncatePrompt returns at most n runes of s for log messages.
func truncatePrompt(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}
