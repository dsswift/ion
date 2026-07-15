package backend

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// compactParams holds the configurable compaction parameters extracted from
// RunOptions. Passed to compactIfNeeded / compactReactive so the compaction
// logic reads policy from config rather than hardcoding values.
type compactParams struct {
	targetPercent     float64
	microKeepTurns    int
	minKeepTurns      int
	estimationPadding float64
	summaryEnabled    bool
	summaryModel      string
	summaryMaxTokens  int
	memoryEnabled     bool
	convDir           string // directory for .tree.jsonl path injection

	// getSessionMemory returns the current session memory content (if any).
	// Set by the session layer via RunConfig.GetSessionMemory. Nil means
	// session memory is not available — the compaction flow skips to the
	// next tier (LLM summary or regex facts).
	getSessionMemory func() string

	// getLastSummarizedEntryID returns the entry ID boundary of the most
	// recent session memory summary. Used to determine whether the memory
	// actually covers the messages being dropped during compaction.
	getLastSummarizedEntryID func() string

	// resetMemoryTracking resets the session memory debounce baselines
	// to the given token count. Called after compaction completes so the
	// growth threshold restarts from the post-compaction level.
	resetMemoryTracking func(tokens int)
}

// buildCompactParams extracts compaction knobs from RunOptions, applying
// defaults from the conversation package for any field the caller didn't set.
func buildCompactParams(opts *types.RunOptions, convDir string) compactParams {
	p := compactParams{
		targetPercent:     conversation.DefaultTargetPercent,
		microKeepTurns:    conversation.DefaultMicroCompactKeep,
		minKeepTurns:      conversation.DefaultMinKeepTurns,
		estimationPadding: conversation.DefaultEstimationPadding,
		summaryEnabled:    true,
		convDir:           convDir,
	}
	if opts.CompactTargetPercent > 0 {
		p.targetPercent = opts.CompactTargetPercent
	}
	if opts.CompactMicroKeepTurns > 0 {
		p.microKeepTurns = opts.CompactMicroKeepTurns
	}
	if opts.CompactMinKeepTurns > 0 {
		p.minKeepTurns = opts.CompactMinKeepTurns
	}
	if opts.CompactEstimationPadding > 0 {
		p.estimationPadding = opts.CompactEstimationPadding
	}
	if opts.CompactSummaryEnabled != nil && !*opts.CompactSummaryEnabled {
		p.summaryEnabled = false
	}
	if opts.CompactSummaryModel != "" {
		p.summaryModel = opts.CompactSummaryModel
	}
	if opts.CompactSummaryMaxTokens > 0 {
		p.summaryMaxTokens = opts.CompactSummaryMaxTokens
	}
	if opts.CompactMemoryEnabled != nil {
		p.memoryEnabled = *opts.CompactMemoryEnabled
	}
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "buildCompactParams", map[string]any{
		"target_percent":     p.targetPercent,
		"micro_keep_turns":   p.microKeepTurns,
		"min_keep_turns":     p.minKeepTurns,
		"estimation_padding": p.estimationPadding,
		"summary_enabled":    p.summaryEnabled,
		"summary_model":      p.summaryModel,
		"memory_enabled":     p.memoryEnabled,
	})
	return p
}

// isMemoryCurrent checks whether the session memory covers the messages
// that compaction will drop. It walks the conversation entries backwards
// from the leaf to find the boundary entry ID. If the boundary is found
// in the entry list, the memory covers everything up to that point.
// Returns false when the boundary is empty, not found, or the entries
// list is nil (no coverage information available).
func isMemoryCurrent(conv *conversation.Conversation, boundaryEntryID string) bool {
	if boundaryEntryID == "" || conv.Entries == nil || len(conv.Entries) == 0 {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "isMemoryCurrent: no boundary or entries", map[string]any{
			"boundary": boundaryEntryID,
			"entries":  len(conv.Entries),
		})
		return false
	}

	// Find the boundary entry's position in the entry list.
	boundaryIdx := -1
	for i, e := range conv.Entries {
		if e.ID == boundaryEntryID {
			boundaryIdx = i
			break
		}
	}
	if boundaryIdx < 0 {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "isMemoryCurrent: boundary entry not found in entries", map[string]any{
			"boundary_entry_id": boundaryEntryID,
			"count":             len(conv.Entries),
		})
		return false
	}

	// The memory is current if the boundary entry is in the latter half
	// of the entry list (i.e., the memory covers most of the conversation).
	// If the boundary is in the first half, the memory is stale — it only
	// covers content that was already dropped or is about to be dropped.
	midpoint := len(conv.Entries) / 2
	isCurrent := boundaryIdx >= midpoint
	utils.LogWithFields(utils.LevelDebug, "backend.runloop", "isMemoryCurrent: at →", map[string]any{
		"boundary":      boundaryEntryID,
		"idx":           boundaryIdx,
		"midpoint":      midpoint,
		"total_entries": len(conv.Entries),
		"current":       isCurrent,
	})
	return isCurrent
}

// resolveSessionMemory checks whether the session memory is available and
// covers the current conversation state. Returns the memory content and
// a log reason string. Returns ("", "") when memory should not be used.
func (cp *compactParams) resolveSessionMemory(conv *conversation.Conversation, label string) (summary string, logReason string) {
	if cp.getSessionMemory == nil {
		return "", ""
	}
	mem := cp.getSessionMemory()
	if mem == "" {
		return "", ""
	}
	// Validate that the memory actually covers the messages being
	// dropped. If the boundary entry is stale (deep in already-
	// dropped content), fall through to a fresh LLM summary.
	if cp.getLastSummarizedEntryID != nil {
		entryID := cp.getLastSummarizedEntryID()
		if entryID != "" && isMemoryCurrent(conv, entryID) {
			return mem, fmt.Sprintf("%s compact: using session memory as summary (boundary=%s)", label, entryID)
		}
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compact: session memory exists but doesn't cover recent messages , falling through to LLM summary", map[string]any{
			"label":    label,
			"boundary": entryID,
		})
		return "", ""
	}
	// No boundary tracking available — use memory as-is for
	// backward compatibility with sessions that predate the
	// boundary tracking feature.
	return mem, fmt.Sprintf("%s compact: using session memory as summary (no boundary tracking)", label)
}
