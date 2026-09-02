package conversation

// context_boundary.go answers one question the engine asks before it lets a
// slash command choose the serving model: does this conversation currently
// carry any model-visible history?
//
// The question exists because switching models mid-conversation is expensive.
// A provider prompt cache is keyed per exact model, so a switch forces the
// whole history to be re-sent as cache-creation input rather than read back at
// the cache-read rate. On a large conversation that single turn costs an order
// of magnitude more than a cached turn. A command that declares a model tier
// is therefore safe to honor only at a point where there is no history to
// re-send — the first message of a conversation, or the first message after a
// /clear.

// HasModelVisibleHistory reports whether the conversation currently holds any
// message the model would see on the next turn.
//
// It is deliberately derived from BuildContextPath rather than from a raw
// entry count. The context path is the exact reconstruction the provider
// request is built from, and it already implements every reset rule the tree
// supports: EntryCleared drops all preceding messages, EntryCompaction
// replaces them with a boundary summary, and DisplayOnly rows never enter the
// path at all. Deriving the answer from that one function means the "is this a
// fresh boundary" test can never drift from what the model actually receives —
// a new reset kind added to buildContextPathLocked is honored here for free.
//
// A nil conversation reports false: no conversation is a fresh boundary.
//
// Note that a compaction boundary counts as history. Compaction leaves a
// summary message in the path, and that summary still has to be re-sent to a
// different model, so a post-compaction turn is not a free place to switch.
func HasModelVisibleHistory(conv *Conversation) bool {
	if conv == nil {
		return false
	}
	return len(BuildContextPath(conv)) > 0
}
