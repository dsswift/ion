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
//
// Image blocks are a special case: their wire form carries the full base64
// payload in source.data, which can be megabytes. The provider does NOT bill an
// image by its byte length — vision models charge a roughly fixed per-image
// token cost (a full-resolution image is on the order of ~1.5K tokens). Naively
// JSON-marshaling an image block and dividing its byte length by 3.5 counts a
// 1MB image as ~300K tokens, which catastrophically over-estimates context and
// fires proactive compaction on a conversation the provider considers tiny
// (observed: a 55K-token context estimated at 1.08M because of image bytes).
// EstimateTokens therefore walks structured content and substitutes a fixed
// per-image estimate for any image block, never counting base64 bytes.
func EstimateTokens(content any) int {
	switch c := content.(type) {
	case string:
		return int(math.Ceil(float64(len(c)) / 4.0))
	case []types.LlmMessage:
		// Whole-conversation estimate (the heuristic and post-compaction paths).
		// Sum each message's content image-aware so a base64 image never inflates
		// the total via the slice-wide marshal.
		total := 0
		for i := range c {
			total += EstimateTokens(c[i].Content)
		}
		return total
	case []types.LlmContentBlock:
		return estimateBlocksTokens(c)
	case []any:
		// Content that round-tripped through JSON (loaded from disk) arrives as
		// []any of map[string]any rather than the typed slice. Estimate each
		// element the same way, image-aware.
		total := 0
		for _, el := range c {
			total += estimateAnyBlockTokens(el)
		}
		return total
	default:
		b, err := json.Marshal(c)
		if err != nil {
			utils.Warn("Compaction", fmt.Sprintf("EstimateTokens: json.Marshal failed: %v", err))
			return 0
		}
		return int(math.Ceil(float64(len(b)) / 3.5))
	}
}

// ImageBlockTokenEstimate is the fixed token cost charged for a single image
// content block, regardless of its base64 byte length. Vision providers bill an
// image at a roughly fixed cost (≈1.5K tokens for a full-resolution image); this
// conservative upper-bound keeps the context estimate honest without re-deriving
// per-provider tiling formulas. See EstimateTokens for why byte length must
// never drive the image estimate.
const ImageBlockTokenEstimate = 1600

// estimateBlocksTokens estimates a typed []LlmContentBlock slice, counting image
// blocks at the fixed ImageBlockTokenEstimate and everything else by its
// non-image JSON byte length.
func estimateBlocksTokens(blocks []types.LlmContentBlock) int {
	total := 0
	for i := range blocks {
		blk := blocks[i]
		if blk.Type == "image" || blk.Source != nil {
			// Image block: fixed cost, never the base64 byte length. Drop the
			// heavy Source before marshaling so the rest of the block (small
			// metadata) is still counted.
			blk.Source = nil
			total += ImageBlockTokenEstimate
		}
		b, err := json.Marshal(blk)
		if err != nil {
			utils.Warn("Compaction", fmt.Sprintf("EstimateTokens: block marshal failed: %v", err))
			continue
		}
		total += int(math.Ceil(float64(len(b)) / 3.5))
	}
	return total
}

// estimateAnyBlockTokens estimates a single content block that arrived as a
// JSON-decoded map[string]any (the disk-reload shape). Image blocks — detected
// by type=="image" or the presence of a "source" object — are counted at the
// fixed ImageBlockTokenEstimate with the heavy source data stripped before
// marshaling the remainder.
func estimateAnyBlockTokens(el any) int {
	m, ok := el.(map[string]any)
	if !ok {
		// Unknown shape (e.g. a bare string element) — marshal and divide.
		b, err := json.Marshal(el)
		if err != nil {
			return 0
		}
		return int(math.Ceil(float64(len(b)) / 3.5))
	}
	isImage := m["type"] == "image"
	if _, hasSource := m["source"]; hasSource {
		isImage = true
	}
	total := 0
	if isImage {
		total += ImageBlockTokenEstimate
		// Strip the heavy source before marshaling the metadata remainder so a
		// megabyte of base64 never reaches the byte-length heuristic.
		stripped := make(map[string]any, len(m))
		for k, v := range m {
			if k == "source" {
				continue
			}
			stripped[k] = v
		}
		m = stripped
	}
	b, err := json.Marshal(m)
	if err != nil {
		return total
	}
	return total + int(math.Ceil(float64(len(b))/3.5))
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
		utils.Debug("Compaction", fmt.Sprintf("EffectiveContextWindow: maxOutputTokens=%d, defaulting to %d", maxOutputTokens, DefaultMaxOutputTokens))
		maxOutputTokens = DefaultMaxOutputTokens
	}
	if summaryReserve <= 0 {
		utils.Debug("Compaction", fmt.Sprintf("EffectiveContextWindow: summaryReserve=%d, defaulting to %d", summaryReserve, DefaultCompactSummaryReserve))
		summaryReserve = DefaultCompactSummaryReserve
	}
	effective := window - maxOutputTokens - summaryReserve
	if effective <= 0 {
		utils.Debug("Compaction", fmt.Sprintf("EffectiveContextWindow: effective=%d <= 0 (window=%d - maxOut=%d - reserve=%d), returning raw window=%d", effective, window, maxOutputTokens, summaryReserve, window))
		return window
	}
	return effective
}

// AutoCompactTokenLimit returns the absolute token count at which proactive
// compaction should fire for a given window and per-call max output tokens.
// This is the effective window minus the configured summary reserve.
func AutoCompactTokenLimit(window, maxOutputTokens int) int {
	result := EffectiveContextWindow(window, maxOutputTokens, DefaultCompactSummaryReserve)
	utils.Debug("Compaction", fmt.Sprintf("AutoCompactTokenLimit: window=%d maxOutputTokens=%d result=%d", window, maxOutputTokens, result))
	return result
}

// invalidateTokenCache clears the cached "last input token" figure after the
// conversation has been mutated by compaction. GetContextUsage uses this
// figure to avoid re-estimating large message slices; once the slice changes
// it is stale and would trigger another compaction immediately if reused.
// Cleared values force re-estimation until the next API response updates the
// cache.
func invalidateTokenCache(conv *Conversation) {
	utils.Debug("Compaction", fmt.Sprintf("invalidateTokenCache: zeroing LastInputTokens=%d LastInputTokensMsgCount=%d", conv.LastInputTokens, conv.LastInputTokensMsgCount))
	conv.LastInputTokens = 0
	conv.LastInputTokensMsgCount = 0
}

// GetContextUsage computes context window consumption. When LastInputTokens
// is available (from the previous API response), it adds an estimate for any
// messages added since (e.g. tool results) so the count isn't stale.
func GetContextUsage(conv *Conversation, contextWindow int) ContextUsageInfo {
	limit := contextWindow
	if limit <= 0 {
		utils.Debug("Compaction", fmt.Sprintf("GetContextUsage: contextWindow=%d <= 0, falling back to DefaultContext=%d", contextWindow, DefaultContext))
		limit = DefaultContext
	}

	reported := conv.LastInputTokens
	if reported > 0 && (conv.LastInputTokensMsgCount <= 0 || len(conv.Messages) >= conv.LastInputTokensMsgCount) {
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
	if reported > 0 {
		utils.Debug("Compaction", fmt.Sprintf("GetContextUsage: branch=stale-cache-invalidated reported=%d lastMsgCount=%d currentMsgs=%d — falling through to heuristic", reported, conv.LastInputTokensMsgCount, len(conv.Messages)))
	}

	estimated := EstimateTokens(conv.Messages)
	pct := int(math.Min(100, math.Round(float64(estimated)/float64(limit)*100)))
	utils.Debug("Compaction", fmt.Sprintf("GetContextUsage: branch=heuristic msgs=%d estimated=%d limit=%d pct=%d", len(conv.Messages), estimated, limit, pct))
	return ContextUsageInfo{Percent: pct, Tokens: estimated, Limit: limit, Estimated: true}
}

// Compact drops the oldest messages, keeping keepTurns user+assistant pairs.
func Compact(conv *Conversation, keepTurns int) {
	utils.Debug("Compaction", fmt.Sprintf("Compact: entry keepTurns=%d len(msgs)=%d", keepTurns, len(conv.Messages)))
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
	utils.Debug("Compaction", fmt.Sprintf("Compact: cutIdx=%d pairs=%d", cutIdx, pairs))
	if cutIdx > 0 {
		msgsBefore := len(conv.Messages)
		conv.Messages = conv.Messages[cutIdx:]
		utils.Debug("Compaction", fmt.Sprintf("Compact: truncated msgsBefore=%d msgsAfter=%d msgsDropped=%d", msgsBefore, len(conv.Messages), msgsBefore-len(conv.Messages)))
		invalidateTokenCache(conv)
	} else {
		utils.Debug("Compaction", "Compact: cutIdx=0, no-op")
	}
}

// CompactWithSummary summarizes older messages via the provided function, then drops them.
//
// The resulting summary is injected as a typed compact_boundary block
// (see BuildCompactBoundaryMessage) rather than a prose "[Previous
// conversation summary]: …" prefix. Consumers that walk conv.Messages
// recognise the boundary by block Type, not by substring matching.
func CompactWithSummary(conv *Conversation, summarize func(string) (string, error), keepTurns int) error {
	utils.Debug("Compaction", fmt.Sprintf("CompactWithSummary: entry keepTurns=%d len(msgs)=%d", keepTurns, len(conv.Messages)))
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
	utils.Debug("Compaction", fmt.Sprintf("CompactWithSummary: len(toDrop)=%d cutIdx=%d", len(toDrop), cutIdx))

	var textParts []string
	for _, msg := range toDrop {
		text := extractText(msg)
		if text != "" {
			textParts = append(textParts, "["+msg.Role+"]: "+text)
		}
	}

	if len(textParts) == 0 {
		utils.Debug("Compaction", "CompactWithSummary: no text parts extracted, falling back to plain Compact")
		Compact(conv, keepTurns)
		return nil
	}

	summary, err := summarize(strings.Join(textParts, "\n\n"))
	if err != nil {
		utils.Debug("Compaction", fmt.Sprintf("CompactWithSummary: summarize error (%v), falling back to plain Compact", err))
		Compact(conv, keepTurns)
		return err
	}

	droppedCount := cutIdx
	conv.Messages = conv.Messages[cutIdx:]
	summaryMsg := BuildCompactBoundaryMessage(CompactMeta{
		Trigger:            "manual",
		MessagesSummarized: droppedCount,
		MessagesBefore:     droppedCount + len(conv.Messages),
		MessagesAfter:      len(conv.Messages) + 1,
		Summary:            summary,
	})
	conv.Messages = append([]types.LlmMessage{summaryMsg}, conv.Messages...)
	PostCompactReset(conv)
	return nil
}

// DefaultTargetPercent is the default post-compact target as a percentage of
// the context window. 50% guarantees roughly half the window is free after
// compaction, preventing immediate re-triggering.
const DefaultTargetPercent = 50.0

// DefaultMicroCompactKeep is the number of most-recent user turns whose
// tool_result blocks are protected from micro-compaction clearing.
const DefaultMicroCompactKeep = 3

// MicroCompactToolResultMinChars is the minimum tool_result content length
// (pass 1) above which the block is replaced with ClearedToolResultSentinel.
// Shorter results are left intact — the token savings would be negligible.
const MicroCompactToolResultMinChars = 100

// MicroCompactAssistantTextMaxChars is the maximum assistant text-block length
// (pass 2) above which the block is truncated to this many characters plus a
// truncation marker. Pass 2 only runs when pass 1 cleared nothing.
const MicroCompactAssistantTextMaxChars = 200

// ClearedToolResultSentinel is the placeholder substituted for a cleared
// tool_result block during pass-1 micro-compaction. It is the single canonical
// definition of the marker so the token estimator and any future restore path
// key on one literal rather than a scattered string.
const ClearedToolResultSentinel = "[cleared]"

// truncatedTextSuffix is appended to an assistant text block truncated during
// pass-2 micro-compaction. It doubles as the idempotency marker: a block that
// already ends with this suffix has been truncated and is skipped on a repeat
// pass so text is never double-truncated.
const truncatedTextSuffix = "... [truncated]"

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
	utils.Debug("Compaction", fmt.Sprintf("CompactToTokenBudget: entry targetTokens=%d minKeepTurns=%d padding=%.2f len(msgs)=%d", targetTokens, minKeepTurns, padding, len(conv.Messages)))
	if targetTokens <= 0 {
		utils.Debug("Compaction", fmt.Sprintf("CompactToTokenBudget: targetTokens=%d <= 0, no-op", targetTokens))
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
			utils.Debug("Compaction", fmt.Sprintf("CompactToTokenBudget: budget exceeded at i=%d accumulated=%d userTurns=%d", i, accumulated, userTurns))
			break
		}
	}

	// Adjust cut point to a turn boundary: advance forward until we hit a
	// "user" message so we don't orphan an assistant reply or tool_result.
	prevCutIdx := cutIdx
	for cutIdx < len(conv.Messages) && conv.Messages[cutIdx].Role != "user" {
		cutIdx++
	}
	if cutIdx != prevCutIdx {
		utils.Debug("Compaction", fmt.Sprintf("CompactToTokenBudget: turn-boundary adjustment advanced cutIdx %d -> %d", prevCutIdx, cutIdx))
	}

	if cutIdx > 0 && cutIdx < len(conv.Messages) {
		msgsBefore := len(conv.Messages)
		conv.Messages = conv.Messages[cutIdx:]
		utils.Debug("Compaction", fmt.Sprintf("CompactToTokenBudget: truncated msgsBefore=%d msgsAfter=%d msgsDropped=%d", msgsBefore, len(conv.Messages), msgsBefore-len(conv.Messages)))
		invalidateTokenCache(conv)
	} else {
		utils.Debug("Compaction", fmt.Sprintf("CompactToTokenBudget: no-op cutIdx=%d len(msgs)=%d", cutIdx, len(conv.Messages)))
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
	utils.Debug("Compaction", fmt.Sprintf("MicroCompact: entry keepTurns=%d len(msgs)=%d", keepTurns, len(conv.Messages)))
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
	utils.Debug("Compaction", fmt.Sprintf("MicroCompact: cutIdx=%d (scanning messages 0..%d)", cutIdx, cutIdx-1))

	cleared := 0
	scanned := 0
	for i := 0; i < cutIdx; i++ {
		msg := &conv.Messages[i]
		blocks, ok := msg.Content.([]types.LlmContentBlock)
		if !ok {
			continue
		}
		scanned++
		for j := range blocks {
			if blocks[j].Type == "image" {
				continue // never clear vision data
			}
			if blocks[j].Type == "tool_result" && len(blocks[j].Content) > MicroCompactToolResultMinChars {
				blocks[j].Content = ClearedToolResultSentinel
				cleared++
			}
		}
	}
	utils.Debug("Compaction", fmt.Sprintf("MicroCompact: pass 1: scanned %d messages, cleared %d tool_result blocks", scanned, cleared))
	if cleared > 0 {
		utils.Debug("Compaction", "MicroCompact: pass 1 sufficient, skipping pass 2")
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
			if blocks[j].Type == "text" && len(blocks[j].Text) > MicroCompactAssistantTextMaxChars {
				// Idempotency guard: a block already truncated on a prior
				// micro-compaction pass ends with truncatedTextSuffix. Skip it
				// so a repeat pass never slices the already-truncated string
				// again (which would mangle it and duplicate the suffix).
				if strings.HasSuffix(blocks[j].Text, truncatedTextSuffix) {
					continue
				}
				blocks[j].Text = blocks[j].Text[:MicroCompactAssistantTextMaxChars] + truncatedTextSuffix
				cleared++
			}
		}
	}
	utils.Debug("Compaction", fmt.Sprintf("MicroCompact: pass 2: truncated %d assistant text blocks", cleared))
	if cleared > 0 {
		invalidateTokenCache(conv)
	}
	return cleared
}
