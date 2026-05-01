package conversation

import (
	"encoding/json"
	"math"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// EstimateTokens provides a heuristic token count.
// Strings: ~4 chars/token. Structured content: ~3.5 chars/token (JSON overhead).
func EstimateTokens(content any) int {
	switch c := content.(type) {
	case string:
		return int(math.Ceil(float64(len(c)) / 4.0))
	default:
		b, err := json.Marshal(c)
		if err != nil {
			return 0
		}
		return int(math.Ceil(float64(len(b)) / 3.5))
	}
}

// GetContextUsage computes context window consumption. When LastInputTokens
// is available (from the previous API response), it adds an estimate for any
// messages added since (e.g. tool results) so the count isn't stale.
func GetContextUsage(conv *Conversation, contextWindow int) ContextUsageInfo {
	limit := contextWindow
	if limit <= 0 {
		limit = DefaultContext
	}

	reported := conv.LastInputTokens
	if reported > 0 {
		total := reported
		if conv.LastInputTokensMsgCount > 0 && len(conv.Messages) > conv.LastInputTokensMsgCount {
			for _, msg := range conv.Messages[conv.LastInputTokensMsgCount:] {
				total += EstimateTokens(msg.Content)
			}
		}
		pct := int(math.Min(100, math.Round(float64(total)/float64(limit)*100)))
		return ContextUsageInfo{Percent: pct, Tokens: total, Limit: limit, Estimated: false}
	}

	estimated := EstimateTokens(conv.Messages)
	pct := int(math.Min(100, math.Round(float64(estimated)/float64(limit)*100)))
	return ContextUsageInfo{Percent: pct, Tokens: estimated, Limit: limit, Estimated: true}
}

// Compact drops the oldest messages, keeping keepTurns user+assistant pairs.
func Compact(conv *Conversation, keepTurns int) {
	if keepTurns <= 0 {
		keepTurns = 10
	}

	pairs := 0
	cutIdx := 0
	for i := len(conv.Messages) - 1; i >= 0; i-- {
		if conv.Messages[i].Role == "user" {
			pairs++
		}
		if pairs >= keepTurns {
			cutIdx = i
			break
		}
	}
	if cutIdx > 0 {
		conv.Messages = conv.Messages[cutIdx:]
	}
}

// CompactWithSummary summarizes older messages via the provided function, then drops them.
func CompactWithSummary(conv *Conversation, summarize func(string) (string, error), keepTurns int) error {
	if keepTurns <= 0 {
		keepTurns = 10
	}

	pairs := 0
	cutIdx := 0
	for i := len(conv.Messages) - 1; i >= 0; i-- {
		if conv.Messages[i].Role == "user" {
			pairs++
		}
		if pairs >= keepTurns {
			cutIdx = i
			break
		}
	}
	if cutIdx <= 0 {
		return nil
	}

	toDrop := conv.Messages[:cutIdx]

	var textParts []string
	for _, msg := range toDrop {
		text := extractText(msg)
		if text != "" {
			textParts = append(textParts, "["+msg.Role+"]: "+text)
		}
	}

	if len(textParts) == 0 {
		Compact(conv, keepTurns)
		return nil
	}

	summary, err := summarize(strings.Join(textParts, "\n\n"))
	if err != nil {
		Compact(conv, keepTurns)
		return err
	}

	conv.Messages = conv.Messages[cutIdx:]
	summaryMsg := types.LlmMessage{
		Role:    "user",
		Content: []types.LlmContentBlock{textBlock("[Previous conversation summary]: " + summary)},
	}
	conv.Messages = append([]types.LlmMessage{summaryMsg}, conv.Messages...)
	return nil
}

// MicroCompact progressively shrinks older messages to reduce context size.
// Pass 1: replaces tool_result content >100 chars with "[cleared]".
// Pass 2 (when pass 1 returns 0): also truncates long assistant text blocks.
// Returns the number of blocks modified.
func MicroCompact(conv *Conversation, keepTurns int) int {
	if keepTurns <= 0 {
		keepTurns = 10
	}

	pairs := 0
	cutIdx := len(conv.Messages)
	for i := len(conv.Messages) - 1; i >= 0; i-- {
		if conv.Messages[i].Role == "user" {
			pairs++
		}
		if pairs >= keepTurns {
			cutIdx = i
			break
		}
	}

	cleared := 0
	for i := 0; i < cutIdx; i++ {
		msg := &conv.Messages[i]
		blocks, ok := msg.Content.([]types.LlmContentBlock)
		if !ok {
			continue
		}
		for j := range blocks {
			if blocks[j].Type == "tool_result" && len(blocks[j].Content) > 100 {
				blocks[j].Content = "[cleared]"
				cleared++
			}
		}
	}
	if cleared > 0 {
		return cleared
	}

	for i := 0; i < cutIdx; i++ {
		msg := &conv.Messages[i]
		if msg.Role != "assistant" {
			continue
		}
		blocks, ok := msg.Content.([]types.LlmContentBlock)
		if !ok {
			continue
		}
		for j := range blocks {
			if blocks[j].Type == "text" && len(blocks[j].Text) > 200 {
				blocks[j].Text = blocks[j].Text[:200] + "... [truncated]"
				cleared++
			}
		}
	}
	return cleared
}
