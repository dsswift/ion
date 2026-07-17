package types

// ModelBreakdown is one row in a per-model cost breakdown, reporting the
// aggregate spend attributed to a single model across all conversations in
// the dispatch tree.
//
// Attribution note: token counts are sourced from each conversation's
// .llm.jsonl header (totalInputTokens / totalOutputTokens). A conversation
// that switched models mid-run attributes entirely to the model recorded in
// its final header — per-turn model-switch attribution is not persisted and
// is out of scope. inputTokens is cache-inclusive (matches the persisted
// totalInputTokens semantic; the cache-read/creation split is not stored in
// the header).
type ModelBreakdown struct {
	Model         string  `json:"model"`
	Conversations int     `json:"conversations"`
	InputTokens   int     `json:"inputTokens"`
	OutputTokens  int     `json:"outputTokens"`
	CostUsd       float64 `json:"costUsd"`
	// IsSelf marks this row as the root/viewing conversation's OWN spend rather
	// than a dispatch. When ConversationCostBreakdown walks a dispatch tree, the
	// root conversation (the one being viewed) contributes an IsSelf=true row so
	// consumers can distinguish "this conversation cost me $X" from "the dispatches
	// I launched cost $Y". A model that appears both as the root's model and among
	// its dispatches produces TWO rows: one IsSelf=true (the root, count 1) and one
	// IsSelf=false (the dispatches, count n). The sum across all rows is unchanged —
	// every conversation is still counted exactly once. Omitted from the wire when
	// false so dispatch-only breakdowns stay byte-identical to the pre-IsSelf shape.
	IsSelf bool `json:"isSelf,omitempty"`
}
