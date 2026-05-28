package conversation

import (
	"github.com/dsswift/ion/engine/internal/types"
)

// CompactBoundaryBlockType is the LlmContentBlock.Type discriminator used
// to mark a compaction boundary inside conv.Messages. Exposed as a
// constant so call sites (provider serialisers, scan loops, tests) cannot
// drift by typing the string literal.
const CompactBoundaryBlockType = "compact_boundary"

// CompactMeta carries every piece of metadata a compaction boundary needs
// to render. It mirrors the optional fields on LlmContentBlock so callers
// can populate it once and let BuildCompactBoundaryMessage emit the wire
// shape verbatim. The split exists so the runloop can assemble metadata
// (trigger, msg counts, cleared-block count, fact count) without knowing
// the wire field names.
//
// Field semantics match the matching LlmContentBlock fields; see
// engine/internal/types/llm.go for canonical docs.
type CompactMeta struct {
	Trigger            string
	MessagesSummarized int
	MessagesBefore     int
	MessagesAfter      int
	ClearedBlocks      int
	TokensBefore       int
	Summary            string
	FactCount          int
	RecentFiles        []string
}

// BuildCompactBoundaryMessage is the single construction site for
// compaction-boundary messages. Every site that injects a boundary into
// conv.Messages (the live runloop, the tree-rebuild path in
// BuildContextPath, persistence reload tests) goes through here so the
// wire shape stays byte-identical across origins.
//
// The returned message has Role: "user" — providers route user content
// without special-casing, and a typed system role would force every
// downstream consumer to learn a new shape. The structural marker lives
// on the content block, not the message envelope.
//
// The block carries the Summary as a structured field, not as prose with
// a magic prefix. Scan passes recognise the boundary via the block Type
// constant, never via substring matching on Text.
func BuildCompactBoundaryMessage(meta CompactMeta) types.LlmMessage {
	return types.LlmMessage{
		Role: "user",
		Content: []types.LlmContentBlock{{
			Type:               CompactBoundaryBlockType,
			Trigger:            meta.Trigger,
			MessagesSummarized: meta.MessagesSummarized,
			MessagesBefore:     meta.MessagesBefore,
			MessagesAfter:      meta.MessagesAfter,
			ClearedBlocks:      meta.ClearedBlocks,
			TokensBefore:       meta.TokensBefore,
			Summary:            meta.Summary,
			FactCount:          meta.FactCount,
			RecentFiles:        meta.RecentFiles,
		}},
	}
}

// IsCompactBoundary reports whether a message's content is a single
// compact_boundary block. Handles all three content shapes a message may
// carry: the typed []LlmContentBlock slice (live runloop construction),
// the []interface{} slice with map[string]any blocks (after JSON
// round-trip from disk), and the catch-all (returns false).
//
// The check is intentionally minimal: any message whose first content
// block has Type == "compact_boundary" qualifies. Hosting a boundary
// alongside other blocks is not part of the contract — every producer
// in-tree emits the boundary as a single-block message, so a single-block
// match is sufficient.
func IsCompactBoundary(msg types.LlmMessage) bool {
	switch c := msg.Content.(type) {
	case []types.LlmContentBlock:
		if len(c) == 0 {
			return false
		}
		return c[0].Type == CompactBoundaryBlockType
	case []interface{}:
		if len(c) == 0 {
			return false
		}
		if m, ok := c[0].(map[string]interface{}); ok {
			if t, _ := m["type"].(string); t == CompactBoundaryBlockType {
				return true
			}
		}
		return false
	}
	return false
}

// MessagesAfterLastCompactBoundary returns the slice of conv.Messages
// starting at the most recent compaction boundary (inclusive), or the
// whole slice when no boundary exists.
//
// This is the duplication firewall called out in
// docs/architecture/agent-state.md-style structural notes for compaction
// (see plan: gentle-knitting-cup): every conversation scan that feeds the
// fact extractor or recent-file extractor must route through here so
// facts cannot be re-extracted from earlier boundary summaries. The next
// compaction's input becomes "everything since the last boundary,"
// preserving in-context visibility of prior summaries (the model still
// sees them) while preventing them from feeding the regex pipeline.
//
// Returns conv.Messages unchanged when conv is nil or empty so callers
// can pass either &Conversation directly or a pre-loaded slice without a
// nil guard.
func MessagesAfterLastCompactBoundary(conv *Conversation) []types.LlmMessage {
	if conv == nil || len(conv.Messages) == 0 {
		return nil
	}
	for i := len(conv.Messages) - 1; i >= 0; i-- {
		if IsCompactBoundary(conv.Messages[i]) {
			return conv.Messages[i:]
		}
	}
	return conv.Messages
}

// PostCompactReset performs the cache-invalidation housekeeping that
// every compaction path must run after mutating conv.Messages. Today's
// body is just invalidateTokenCache — the named helper exists so future
// cache resets (file-state, embedding cache, etc.) land in one obvious
// place rather than scattered across the runloop, mirroring Claude
// Code's runPostCompactCleanup pattern.
//
// Safe on nil conv (no-op) so callers don't need a guard.
func PostCompactReset(conv *Conversation) {
	if conv == nil {
		return
	}
	invalidateTokenCache(conv)
}
