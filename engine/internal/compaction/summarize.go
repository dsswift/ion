package compaction

import (
	"context"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// DefaultSummaryMaxTokens is the maximum output tokens for a compaction
// summary LLM call. 4096 tokens is enough for a thorough summary without
// excessive cost on a fast-tier model.
const DefaultSummaryMaxTokens = 4096

// authResolver is set by the host process (same pattern as titling).
// It ensures API keys from the keychain are available before calling a provider.
var authResolver func(providerName string)

// SetAuthResolver configures the auth resolver for summary LLM calls.
// Must be called during engine initialization, before any compaction runs.
func SetAuthResolver(fn func(providerName string)) {
	authResolver = fn
}

// summarySystemPrompt is the instruction sent to the summarization model.
const summarySystemPrompt = `You are summarizing a conversation that is being compacted to free context window space. Produce a structured summary that preserves the most important context for continuing the conversation.

Include these sections (skip any that have no content):

## Current Task
What is actively being worked on right now. Include specific file names, function names, and the exact state of progress.

## Key Decisions
Important choices made during the conversation — technologies selected, approaches chosen, trade-offs accepted.

## Recent Changes
Files created, modified, or deleted. Include paths and a brief note on what changed.

## Errors & Fixes
Problems encountered and how they were resolved. Include error messages if they might recur.

## Pending Work
Tasks explicitly requested but not yet completed. Include any user instructions that haven't been acted on.

## Important Context
User preferences, project conventions, or constraints mentioned that should inform future work.

Do NOT include text from system prompts, AGENTS.md/CLAUDE.md content, or agent task descriptions. These are injected automatically and should not be preserved in the summary.

Be concise but specific. Preserve exact file paths, function names, error messages, and command outputs that would be needed to continue the work. Do not include preamble or meta-commentary about the summary itself.`

// resolveSummaryModel determines which model to use for the summary call.
// Priority: explicit model > "fast" tier > defaultModel from config > empty.
//
// This follows the same resolution pattern as titling.go: check the user's
// tier configuration first, then fall back to their configured default model.
// Returns empty string when neither is set — callers should skip the LLM
// call rather than substitute a built-in default.
func resolveSummaryModel(explicitModel string) string {
	if explicitModel != "" {
		utils.Debug("Compaction", fmt.Sprintf("resolveSummaryModel: explicit=%s", explicitModel))
		return explicitModel
	}

	// Check if user configured a "fast" tier in models.json.
	if fast := modelconfig.ResolveTier("fast"); fast != "" && fast != "fast" {
		utils.Debug("Compaction", fmt.Sprintf("resolveSummaryModel: fast-tier=%s", fast))
		return fast
	}

	// Fall back to the user's defaultModel.
	config := modelconfig.LoadModelsConfig()
	if dm, ok := config["defaultModel"].(string); ok && dm != "" {
		utils.Debug("Compaction", fmt.Sprintf("resolveSummaryModel: defaultModel=%s", dm))
		return dm
	}

	utils.Debug("Compaction", "resolveSummaryModel: no model configured")
	return ""
}

// Summarize generates an LLM-based summary of the provided conversation
// text. It makes a single lightweight streaming call (no tools, no runloop)
// following the same pattern as titling.
//
// Returns the summary text, or empty string on any error. The caller should
// fall back to regex-based fact extraction when the summary is empty.
//
// Usage data is returned as the second value so the caller can emit a
// UsageEvent for cost tracking. It may be nil on error.
func Summarize(ctx context.Context, text, model string, maxTokens int) (string, *types.LlmUsage) {
	resolved := resolveSummaryModel(model)
	if resolved == "" {
		utils.Debug("Compaction", "Summarize: no model available, skipping LLM summary")
		return "", nil
	}
	if maxTokens <= 0 {
		maxTokens = DefaultSummaryMaxTokens
	}

	// Ensure the provider has a valid API key before we attempt to stream.
	// The provider init may not have the key (e.g. stored in keychain, not
	// in env vars), so we resolve it through the auth chain.
	if authResolver != nil {
		if pn := providers.ProviderNameForModel(resolved); pn != "" {
			authResolver(pn)
		}
	}

	provider := providers.ResolveProvider(resolved)
	if provider == nil {
		utils.Log("Compaction", fmt.Sprintf("Summarize: no provider found for model %q", resolved))
		return "", nil
	}

	utils.Log("Compaction", fmt.Sprintf("Summarize: starting LLM summary call model=%s maxTokens=%d inputLen=%d", resolved, maxTokens, len(text)))

	messages := []types.LlmMessage{
		{
			Role:    "user",
			Content: text,
		},
	}

	events, errc := provider.Stream(ctx, types.LlmStreamOptions{
		Model:     resolved,
		System:    summarySystemPrompt,
		Messages:  messages,
		MaxTokens: maxTokens,
	})

	var response strings.Builder
	var usage types.LlmUsage

	for ev := range events {
		switch ev.Type {
		case "message_start":
			// Capture input token counts from message metadata.
			if ev.MessageInfo != nil {
				usage = ev.MessageInfo.Usage
			}
		case "content_block_delta":
			if ev.Delta != nil && ev.Delta.Text != "" {
				response.WriteString(ev.Delta.Text)
			}
		case "message_delta":
			// Accumulate output token counts from the final delta.
			if ev.DeltaUsage != nil {
				usage.OutputTokens += ev.DeltaUsage.OutputTokens
			}
		}
	}

	// Drain the error channel (same pattern as titling.go).
	if errc != nil {
		if err := <-errc; err != nil {
			utils.Warn("Compaction", fmt.Sprintf("Summarize: LLM call failed: %v", err))
			return "", nil
		}
	}

	result := strings.TrimSpace(response.String())
	utils.Log("Compaction", fmt.Sprintf(
		"Summarize: completed, summary length=%d chars, inputTokens=%d outputTokens=%d",
		len(result), usage.InputTokens, usage.OutputTokens,
	))

	if result == "" {
		utils.Warn("Compaction", "Summarize: LLM returned empty response")
		return "", nil
	}

	return result, &usage
}

// FormatMessagesForSummary formats a slice of LLM messages into a text
// representation suitable for the summarization prompt. Each message is
// prefixed with its role and non-empty text content is included.
//
// Tool results are truncated more aggressively (500 chars) than user/assistant
// messages (2000 chars) because tool results often contain system prompt echoes,
// verbose command output, and file content that the LLM should not memorize.
func FormatMessagesForSummary(messages []types.LlmMessage) string {
	utils.Debug("Compaction", fmt.Sprintf("FormatMessagesForSummary: %d messages", len(messages)))
	var parts []string
	truncated := 0
	toolResultsTruncated := 0
	for _, msg := range messages {
		text := extractText(msg)
		if text == "" {
			continue
		}

		// Tool results get a shorter budget to reduce noise from system
		// prompt echoes, verbose command output, and file content dumps.
		isToolResult := msg.Role == "user" && hasToolResults(msg)
		limit := 2000
		if isToolResult {
			limit = 500
		}

		if len(text) > limit {
			text = text[:limit] + "... [truncated]"
			truncated++
			if isToolResult {
				toolResultsTruncated++
			}
		}
		parts = append(parts, fmt.Sprintf("[%s]: %s", msg.Role, text))
	}
	result := strings.Join(parts, "\n\n")
	utils.Debug("Compaction", fmt.Sprintf("FormatMessagesForSummary: done totalLen=%d truncatedMsgs=%d toolResultsTruncated=%d", len(result), truncated, toolResultsTruncated))
	return result
}
