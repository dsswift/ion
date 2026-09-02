package types

// SlashModelTierConfig controls command-owned model selection after history
// exists. The engine owns the boundary mechanics; operators and harnesses own
// whether preserving the current model cache is the right policy for a run.
type SlashModelTierConfig struct {
	ApplyMidConversation bool `json:"applyMidConversation,omitempty"`
}
