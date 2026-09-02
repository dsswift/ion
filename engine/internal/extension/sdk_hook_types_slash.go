package extension

// SlashModelBoundaryInfo describes the pending model-selection decision for a
// resolved slash command. The engine supplies its configured default in
// DefaultApply; a handler can override it without reimplementing history checks.
type SlashModelBoundaryInfo struct {
	Command       string `json:"command"`
	RequestedTier string `json:"requestedTier"`
	ServingModel  string `json:"servingModel"`
	HasHistory    bool   `json:"hasHistory"`
	DefaultApply  bool   `json:"defaultApply"`
}

// SlashModelBoundaryResult is the optional decision returned by
// before_slash_model_boundary. Nil Apply abstains; an explicit value overrides
// configuration for this invocation.
type SlashModelBoundaryResult struct {
	Apply *bool `json:"apply,omitempty"`
}
