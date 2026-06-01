package conversation

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// DefaultMaxOutputTokens is the headroom reserved for the model's next
// response when computing the effective context window.
const DefaultMaxOutputTokens = 20000

// DefaultCompactSummaryReserve is the headroom reserved so the compaction
// summary itself (fact extraction + restore message) doesn't push us past
// the window. Stays well clear of the trigger limit.
const DefaultCompactSummaryReserve = 13000

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

// EffectiveContextWindow returns the usable window after reserving room for
// the next model response and for the compaction summary. Callers pass the
// model's max output tokens; zero falls back to DefaultMaxOutputTokens.
// Returns the input window unchanged when reserves would consume all of it
// (e.g. very small custom windows in tests).
func EffectiveContextWindow(window, maxOutputTokens, summaryReserve int) int {
	if window <= 0 {
		return 0
	}
	if maxOutputTokens <= 0 {
		maxOutputTokens = DefaultMaxOutputTokens
	}
	if summaryReserve <= 0 {
		summaryReserve = DefaultCompactSummaryReserve
	}
	effective := window - maxOutputTokens - summaryReserve
	if effective <= 0 {
		return window
	}
	return effective
}

// AutoCompactTokenLimit returns the absolute token count at which proactive
// compaction should fire for a given window and per-call max output tokens.
// This is the effective window minus the configured summary reserve.
func AutoCompactTokenLimit(window, maxOutputTokens int) int {
	return EffectiveContextWindow(window, maxOutputTokens, DefaultCompactSummaryReserve)
}

// invalidateTokenCache clears the cached "last input token" figure after the
// conversation has been mutated by compaction. GetContextUsage uses this
// figure to avoid re-estimating large message slices; once the slice changes
// it is stale and would trigger another compaction immediately if reused.
// Cleared values force re-estimation until the next API response updates the
// cache.
func invalidateTokenCache(conv *Conversation) {
	conv.LastInputTokens = 0
	conv.LastInputTokensMsgCount = 0
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
		utils.Debug("Compaction", fmt.Sprintf("GetContextUsage: branch=api-cached reported=%d msgCount=%d currentMsgs=%d total=%d limit=%d pct=%d", reported, conv.LastInputTokensMsgCount, len(conv.Messages), total, limit, pct))
		return ContextUsageInfo{Percent: pct, Tokens: total, Limit: limit, Estimated: false}
	}

	estimated := EstimateTokens(conv.Messages)
	pct := int(math.Min(100, math.Round(float64(estimated)/float64(limit)*100)))
	utils.Debug("Compaction", fmt.Sprintf("GetContextUsage: branch=heuristic msgs=%d estimated=%d limit=%d pct=%d", len(conv.Messages), estimated, limit, pct))
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
		invalidateTokenCache(conv)
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
	invalidateTokenCache(conv)
	return nil
}

// DefaultTargetPercent is the default post-compact target as a percentage of
// the context window. 50% guarantees roughly half the window is free after
// compaction, preventing immediate re-triggering.
const DefaultTargetPercent = 50.0

// DefaultMicroCompactKeep is the number of most-recent user turns whose
// tool_result blocks are protected from micro-compaction clearing.
const DefaultMicroCompactKeep = 3

// DefaultMinKeepTurns is the safety floor — compaction never drops below
// this many user turns, even if they exceed the token budget.
const DefaultMinKeepTurns = 2

// DefaultEstimationPadding is the multiplier applied to heuristic token
// estimates during compaction decisions. A 33% buffer prevents under-
// estimation from triggering immediate re-compaction.
const DefaultEstimationPadding = 1.33

// CompactToTokenBudget drops the oldest messages so the remaining
// conversation fits within targetTokens (estimated). Unlike Compact which
// keeps a fixed turn count, this function targets a token budget, ensuring
// predictable post-compact headroom regardless of message size.
//
// The cut respects turn boundaries: it never orphans a tool_result from its
// preceding tool_use, and never splits a user/assistant pair. minKeepTurns
// is a safety floor — at least that many user turns are preserved even if
// they exceed the budget. padding is applied to each message's token
// estimate (e.g. 1.33 for 33% conservative buffer).
func CompactToTokenBudget(conv *Conversation, targetTokens, minKeepTurns int, padding float64) {
	if targetTokens <= 0 {
		return
	}
	if minKeepTurns <= 0 {
		minKeepTurns = DefaultMinKeepTurns
	}
	if padding <= 0 {
		padding = DefaultEstimationPadding
	}

	// Walk backward, accumulating token estimates and counting user turns.
	accumulated := 0
	userTurns := 0
	cutIdx := 0 // everything before cutIdx is dropped

	for i := len(conv.Messages) - 1; i >= 0; i-- {
		est := int(float64(EstimateTokens(conv.Messages[i].Content)) * padding)
		accumulated += est

		if conv.Messages[i].Role == "user" {
			userTurns++
		}

		// Once we've exceeded the budget and met the minimum turn floor,
		// find the cut point. We cut at the current position so everything
		// from i onward is kept.
		if accumulated > targetTokens && userTurns >= minKeepTurns {
			cutIdx = i
			break
		}
	}

	// Adjust cut point to a turn boundary: advance forward until we hit a
	// "user" message so we don't orphan an assistant reply or tool_result.
	for cutIdx < len(conv.Messages) && conv.Messages[cutIdx].Role != "user" {
		cutIdx++
	}

	if cutIdx > 0 && cutIdx < len(conv.Messages) {
		conv.Messages = conv.Messages[cutIdx:]
		invalidateTokenCache(conv)
	}
}

// MicroCompact progressively shrinks older messages to reduce context size.
// Pass 1: replaces tool_result content >100 chars with "[cleared]".
//
//	Image blocks (type "image") are never cleared — they carry vision data
//	that cannot be meaningfully summarised as text.
//
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
			if blocks[j].Type == "image" {
				continue // never clear vision data
			}
			if blocks[j].Type == "tool_result" && len(blocks[j].Content) > 100 {
				blocks[j].Content = "[cleared]"
				cleared++
			}
		}
	}
	if cleared > 0 {
		invalidateTokenCache(conv)
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
	if cleared > 0 {
		invalidateTokenCache(conv)
	}
	return cleared
}
