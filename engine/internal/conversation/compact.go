package conversation

import (
	"encoding/json"
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
			utils.LogWithFields(utils.LevelWarn, "conversation.compact", "estimate tokens json marshal failed", map[string]any{"error": err.Error()})
			return 0
		}
		return int(math.Ceil(float64(len(b)) / 3.5))
	}
}

// ImageBlockTokenEstimate is the fixed token cost charged for a single image
// content block, regardless of its base64 byte length. Re-exported from
// types.ImageBlockTokenEstimate so this package's long-standing name keeps
// working while there is exactly ONE value shared with providers'
// BuildContextBreakdown (which cannot import this package). See the doc comment
// on types.ImageBlockTokenEstimate, and EstimateTokens above for why byte
// length must never drive the image estimate.
const ImageBlockTokenEstimate = types.ImageBlockTokenEstimate

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
			utils.LogWithFields(utils.LevelWarn, "conversation.compact", "estimate tokens block marshal failed", map[string]any{"error": err.Error()})
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
		utils.LogWithFields(utils.LevelDebug, "conversation.compact", "effective context window max output tokens defaulting", map[string]any{"max": maxOutputTokens, "count": DefaultMaxOutputTokens})
		maxOutputTokens = DefaultMaxOutputTokens
	}
	if summaryReserve <= 0 {
		utils.LogWithFields(utils.LevelDebug, "conversation.compact", "effective context window summary reserve defaulting", map[string]any{"max": summaryReserve, "count": DefaultCompactSummaryReserve})
		summaryReserve = DefaultCompactSummaryReserve
	}
	effective := window - maxOutputTokens - summaryReserve
	if effective <= 0 {
		utils.LogWithFields(utils.LevelDebug, "conversation.compact", "effective context window zero or negative returning raw", map[string]any{"count": effective, "max": window})
		return window
	}
	return effective
}

// AutoCompactTokenLimit returns the absolute token count at which proactive
// compaction should fire for a given window and per-call max output tokens.
// This is the effective window minus the configured summary reserve.
func AutoCompactTokenLimit(window, maxOutputTokens int) int {
	result := EffectiveContextWindow(window, maxOutputTokens, DefaultCompactSummaryReserve)
	utils.LogWithFields(utils.LevelDebug, "conversation.compact", "auto compact token limit", map[string]any{"count": window, "max": maxOutputTokens, "turn": result})
	return result
}

// lastAssistantUsageLocked scans conv.Messages backward for the most recent
// assistant message carrying API-reported Usage and returns its index, or -1
// when no such message exists. Callers must hold conv.mu.
//
// Extracted so GetContextUsage (which needs the index, to estimate messages
// appended after it) and LastAssistantUsage (which needs only the usage) share
// one scan. Duplicating the loop is how the compaction numerator and the
// breakdown reconciliation baseline would silently drift apart.
func lastAssistantUsageLocked(conv *Conversation) int {
	for i := len(conv.Messages) - 1; i >= 0; i-- {
		if conv.Messages[i].Role == "assistant" && conv.Messages[i].Usage != nil {
			return i
		}
	}
	return -1
}

// LastAssistantUsage returns the API-reported token usage from the most recent
// assistant message that carries it, or nil when the conversation has none (a
// conversation that has not yet had an API response, or one loaded from a
// legacy file that predates usage tracking on entries).
//
// This is the provider's own accounting of what the model actually carried —
// the same figure GetContextUsage builds its Tokens on. Callers that need to
// reconcile an independently-derived estimate against provider truth use this
// as the baseline; see session.ComputeAndEmitContextBreakdown.
//
// The returned pointer aliases the message's Usage; treat it as read-only.
func LastAssistantUsage(conv *Conversation) *types.LlmUsage {
	if conv == nil {
		return nil
	}
	conv.lock()
	defer conv.unlock()
	idx := lastAssistantUsageLocked(conv)
	if idx < 0 {
		return nil
	}
	return conv.Messages[idx].Usage
}

// GetContextUsage computes context window consumption. It scans conv.Messages
// backward for the most recent assistant message that carries API-reported
// Usage (set by AddAssistantMessage and rehydrated from entries at load time),
// reads its token total, and adds an estimate for any messages appended after
// it (e.g. tool results added in the current turn that have not yet been sent
// to the API). When no such message exists (new conversation or immediately
// after compaction), it falls back to a heuristic estimate of conv.Messages
// plus conv.System, which is used until the next API response populates Usage
// on a new assistant message.
//
// Percent is UNBOUNDED: it is the true Tokens/Limit ratio and may exceed 100.
// A value above 100 means the conversation holds more tokens than the window
// being measured against — the normal case when a conversation accumulated
// under a large-window model and is then measured against a smaller one.
// Callers that render Percent into a fixed-width bar must clamp at their own
// display layer; the engine reports the real figure. Tokens has always been
// unclamped and remains the input to every compaction decision.
func GetContextUsage(conv *Conversation, contextWindow int) ContextUsageInfo {
	conv.lock()
	defer conv.unlock()
	limit := contextWindow
	if limit <= 0 {
		utils.LogWithFields(utils.LevelDebug, "conversation.compact", "get context usage context window zero falling back to default", map[string]any{"count": contextWindow, "max": DefaultContext})
		limit = DefaultContext
	}

	// Backward scan: find the last assistant message with API-reported usage.
	lastUsageIdx := lastAssistantUsageLocked(conv)

	if lastUsageIdx >= 0 {
		u := conv.Messages[lastUsageIdx].Usage
		total := u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens
		// Estimate any messages appended after the last API response (e.g. tool
		// results in the current turn). These are not yet reflected in the API
		// count and may be substantial in a tool-heavy turn.
		for _, msg := range conv.Messages[lastUsageIdx+1:] {
			total += EstimateTokens(msg.Content)
		}
		pct := int(math.Round(float64(total) / float64(limit) * 100))
		utils.LogWithFields(utils.LevelDebug, "conversation.compact", "get context usage api cached", map[string]any{
			"turn": total, "count": lastUsageIdx, "max": len(conv.Messages),
		})
		return ContextUsageInfo{Percent: pct, Tokens: total, Limit: limit, Estimated: false}
	}

	// Fallback: no API-reported usage available. This occurs on truly new
	// conversations and immediately after compaction (before the next API
	// response populates Usage). Estimate from message content plus system
	// prompt so the threshold check has a reasonable signal.
	estimated := EstimateTokens(conv.Messages)
	if conv.System != "" {
		estimated += EstimateTokens(conv.System)
	}
	pct := int(math.Round(float64(estimated) / float64(limit) * 100))
	utils.LogWithFields(utils.LevelDebug, "conversation.compact", "get context usage heuristic", map[string]any{
		"count": len(conv.Messages), "turn": estimated,
	})
	return ContextUsageInfo{Percent: pct, Tokens: estimated, Limit: limit, Estimated: true}
}

// Compact drops the oldest messages, keeping keepTurns user+assistant pairs.
func Compact(conv *Conversation, keepTurns int) {
	conv.lock()
	defer conv.unlock()
	compactLocked(conv, keepTurns)
}

// compactLocked is Compact's body; callers must hold conv.mu.
func compactLocked(conv *Conversation, keepTurns int) {
	utils.LogWithFields(utils.LevelDebug, "conversation.compact", "compact entry", map[string]any{"turn": keepTurns, "count": len(conv.Messages)})
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
	utils.LogWithFields(utils.LevelDebug, "conversation.compact", "compact cut index and pairs", map[string]any{"count": cutIdx, "max": pairs})
	if cutIdx > 0 {
		msgsBefore := len(conv.Messages)
		conv.Messages = conv.Messages[cutIdx:]
		utils.LogWithFields(utils.LevelDebug, "conversation.compact", "compact truncated", map[string]any{
			"count": msgsBefore, "max": len(conv.Messages),
		})
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
	utils.LogWithFields(utils.LevelDebug, "conversation.compact", "compact with summary entry", map[string]any{"turn": keepTurns, "count": len(conv.Messages)})
	if keepTurns <= 0 {
		keepTurns = 10
	}

	// Scan under the lock; release it before the summarize call (an LLM
	// round-trip) so persistence flushes are never blocked on network I/O.
	// Messages appends are single-writer (the runloop), so cutIdx stays valid
	// across the unlocked window.
	conv.lock()
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
		conv.unlock()
		return nil
	}

	toDrop := conv.Messages[:cutIdx]
	utils.LogWithFields(utils.LevelDebug, "conversation.compact", "compact with summary len to drop and cut index", map[string]any{"count": len(toDrop), "max": cutIdx})

	var textParts []string
	for _, msg := range toDrop {
		text := extractText(msg)
		if text != "" {
			textParts = append(textParts, "["+msg.Role+"]: "+text)
		}
	}

	if len(textParts) == 0 {
		utils.Debug("Compaction", "CompactWithSummary: no text parts extracted, falling back to plain Compact")
		compactLocked(conv, keepTurns)
		conv.unlock()
		return nil
	}
	conv.unlock()

	summary, err := summarize(strings.Join(textParts, "\n\n"))
	if err != nil {
		utils.LogWithFields(utils.LevelDebug, "conversation.compact", "compact with summary summarize error falling back to plain compact", map[string]any{"error": err.Error()})
		Compact(conv, keepTurns)
		return err
	}

	conv.lock()
	defer conv.unlock()
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
// TokenBudgetCut is a non-mutating truncation plan. CutIndex is the first
// message retained; Dropped is the source-message count removed. EstimatedTokens
// is the padded estimate of the complete input slice, computed with the exact
// estimator the cut decision used.
type TokenBudgetCut struct {
	CutIndex        int
	Dropped         int
	EstimatedTokens int
}

// EstimateTokenBudgetInput returns the padded message estimate used by the cut
// planner. Forced compaction derives its target from this exact token basis so
// the target is always reachable by the message trimmer.
func EstimateTokenBudgetInput(messages []types.LlmMessage, padding float64) int {
	if padding <= 0 {
		padding = DefaultEstimationPadding
	}
	total := 0
	for i := range messages {
		total += int(float64(EstimateTokens(messages[i].Content)) * padding)
	}
	return total
}

// PlanTokenBudgetCut computes the same turn-safe cut CompactToTokenBudget
// applies, without mutating messages. Planning first lets callers avoid summary
// work when no source message can be removed and summarize only the dropped
// prefix when a cut exists.
func PlanTokenBudgetCut(messages []types.LlmMessage, targetTokens, minKeepTurns int, padding float64) TokenBudgetCut {
	if targetTokens <= 0 || len(messages) == 0 {
		return TokenBudgetCut{}
	}
	if minKeepTurns <= 0 {
		minKeepTurns = DefaultMinKeepTurns
	}
	if padding <= 0 {
		padding = DefaultEstimationPadding
	}

	total := EstimateTokenBudgetInput(messages, padding)
	if total <= targetTokens {
		return TokenBudgetCut{EstimatedTokens: total}
	}

	accumulated := 0
	userTurns := 0
	cutIdx := 0
	for i := len(messages) - 1; i >= 0; i-- {
		accumulated += int(float64(EstimateTokens(messages[i].Content)) * padding)
		if messages[i].Role == "user" {
			userTurns++
		}
		if accumulated > targetTokens && userTurns >= minKeepTurns {
			cutIdx = i
			break
		}
	}
	// Never orphan an assistant/tool-result suffix. The retained slice begins
	// on the next user boundary.
	for cutIdx < len(messages) && messages[cutIdx].Role != "user" {
		cutIdx++
	}
	if cutIdx <= 0 || cutIdx >= len(messages) {
		return TokenBudgetCut{EstimatedTokens: total}
	}
	return TokenBudgetCut{CutIndex: cutIdx, Dropped: cutIdx, EstimatedTokens: total}
}

// CompactToTokenBudget applies PlanTokenBudgetCut. Existing callers retain the
// mutation-only API while compaction orchestration can plan before paying for a
// summary.
func CompactToTokenBudget(conv *Conversation, targetTokens, minKeepTurns int, padding float64) {
	conv.lock()
	defer conv.unlock()
	cut := PlanTokenBudgetCut(conv.Messages, targetTokens, minKeepTurns, padding)
	utils.LogWithFields(utils.LevelDebug, "conversation.compact", "compact to token budget planned", map[string]any{
		"target_tokens":    targetTokens,
		"estimated_tokens": cut.EstimatedTokens,
		"cut_index":        cut.CutIndex,
		"dropped_messages": cut.Dropped,
	})
	if cut.Dropped == 0 {
		return
	}
	conv.Messages = conv.Messages[cut.CutIndex:]
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
	conv.lock()
	defer conv.unlock()
	utils.LogWithFields(utils.LevelDebug, "conversation.compact", "micro compact entry", map[string]any{"turn": keepTurns, "count": len(conv.Messages)})
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
	utils.LogWithFields(utils.LevelDebug, "conversation.compact", "micro compact cut index scanning", map[string]any{"count": cutIdx})

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
	utils.LogWithFields(utils.LevelDebug, "conversation.compact", "micro compact pass 1 scanned and cleared tool result blocks", map[string]any{"count": scanned, "max": cleared})
	if cleared > 0 {
		utils.Debug("Compaction", "MicroCompact: pass 1 sufficient, skipping pass 2")
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
	utils.LogWithFields(utils.LevelDebug, "conversation.compact", "micro compact pass 2 truncated assistant text blocks", map[string]any{"count": cleared})
	return cleared
}
