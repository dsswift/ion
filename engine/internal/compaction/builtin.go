package compaction

import (
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// --- MicroCompactStrategy ---

// MicroCompactStrategy clears stale tool_result content from older messages,
// reducing token count without losing conversational structure.
type MicroCompactStrategy struct{}

func (MicroCompactStrategy) Name() string        { return "micro-compact" }
func (MicroCompactStrategy) Description() string { return "Clear old tool result content" }

func (MicroCompactStrategy) CanHandle(messages []types.LlmMessage, _ *CompactionOptions) bool {
	return len(messages) > 0
}

func (MicroCompactStrategy) Compact(messages []types.LlmMessage, _ *CompactionOptions) ([]types.LlmMessage, *CompactionResult, error) {
	before := len(messages)
	out := make([]types.LlmMessage, len(messages))

	for i, msg := range messages {
		blocks, ok := msg.Content.([]types.LlmContentBlock)
		if !ok {
			out[i] = msg
			continue
		}

		cleaned := make([]types.LlmContentBlock, len(blocks))
		copy(cleaned, blocks)
		for j := range cleaned {
			if cleaned[j].Type == "tool_result" && cleaned[j].Content != "" {
				cleaned[j].Content = "[compacted]"
			}
		}
		out[i] = types.LlmMessage{Role: msg.Role, Content: cleaned}
	}

	return out, &CompactionResult{
		Strategy:       "micro-compact",
		MessagesBefore: before,
		MessagesAfter:  len(out),
	}, nil
}

// --- SummaryCompactStrategy ---

// SummaryCompactStrategy replaces older messages with an LLM-generated summary.
// Requires opts.Summarize to be set.
type SummaryCompactStrategy struct{}

func (SummaryCompactStrategy) Name() string        { return "summary-compact" }
func (SummaryCompactStrategy) Description() string { return "Replace older messages with an LLM summary" }

func (SummaryCompactStrategy) CanHandle(messages []types.LlmMessage, opts *CompactionOptions) bool {
	return len(messages) > 2 && opts != nil && opts.Summarize != nil
}

func (SummaryCompactStrategy) Compact(messages []types.LlmMessage, opts *CompactionOptions) ([]types.LlmMessage, *CompactionResult, error) {
	if opts == nil || opts.Summarize == nil {
		return nil, nil, fmt.Errorf("summary-compact requires a Summarize callback")
	}

	before := len(messages)

	keepTurns := opts.KeepTurns
	if keepTurns <= 0 {
		keepTurns = 2
	}

	// Split into older messages to summarize and recent messages to keep.
	splitIdx := before - keepTurns
	if splitIdx < 1 {
		splitIdx = 1
	}
	older := messages[:splitIdx]
	recent := messages[splitIdx:]

	// Build a text blob from the older messages for the summarizer.
	var sb strings.Builder
	for _, msg := range older {
		text := extractText(msg)
		if text != "" {
			fmt.Fprintf(&sb, "[%s]: %s\n", msg.Role, text)
		}
	}

	summary, err := opts.Summarize(sb.String())
	if err != nil {
		return nil, nil, fmt.Errorf("summary-compact: summarize failed: %w", err)
	}

	summaryMsg := types.LlmMessage{
		Role: "user",
		Content: []types.LlmContentBlock{{
			Type: "text",
			Text: "[Conversation summary]\n" + summary,
		}},
	}

	out := make([]types.LlmMessage, 0, 1+len(recent))
	out = append(out, summaryMsg)
	out = append(out, recent...)

	return out, &CompactionResult{
		Strategy:       "summary-compact",
		MessagesBefore: before,
		MessagesAfter:  len(out),
	}, nil
}

// --- TruncateStrategy ---

// TruncateStrategy drops the oldest messages, keeping only the most recent turns.
type TruncateStrategy struct{}

func (TruncateStrategy) Name() string        { return "truncate" }
func (TruncateStrategy) Description() string { return "Drop oldest messages, keep recent turns" }

func (TruncateStrategy) CanHandle(messages []types.LlmMessage, _ *CompactionOptions) bool {
	return len(messages) > 2
}

func (TruncateStrategy) Compact(messages []types.LlmMessage, opts *CompactionOptions) ([]types.LlmMessage, *CompactionResult, error) {
	before := len(messages)

	keepTurns := 2
	if opts != nil && opts.KeepTurns > 0 {
		keepTurns = opts.KeepTurns
	}

	if keepTurns >= before {
		out := make([]types.LlmMessage, before)
		copy(out, messages)
		return out, &CompactionResult{
			Strategy:       "truncate",
			MessagesBefore: before,
			MessagesAfter:  before,
		}, nil
	}

	out := make([]types.LlmMessage, keepTurns)
	copy(out, messages[before-keepTurns:])

	return out, &CompactionResult{
		Strategy:       "truncate",
		MessagesBefore: before,
		MessagesAfter:  len(out),
	}, nil
}

// --- Registration ---

// RegisterBuiltinStrategies registers the three built-in compaction strategies.
func RegisterBuiltinStrategies() {
	RegisterStrategy(MicroCompactStrategy{})
	RegisterStrategy(SummaryCompactStrategy{})
	RegisterStrategy(TruncateStrategy{})
}
