package types

// ClientWorkspaceContext is a client-supplied workspace descriptor carried on
// EngineConfig (session-level) and ClientCommand (per-prompt). When present it
// overrides the engine's own worktree-registry lookup, letting the client
// (desktop, iOS, or any external harness) supply workspace facts directly.
//
// Field mapping to hook payloads (PromptContext):
//
//	Kind  → PromptContext.Kind  (as ContextKind)
//	Cwd   → PromptContext.Cwd
//	Bench → PromptContext.Bench
//	Data  → PromptContext.Client
//	Text  → appended to the system prompt as formatted prose
type ClientWorkspaceContext struct {
	Kind  string         `json:"kind"`
	Cwd   string         `json:"cwd"`
	Bench map[string]any `json:"bench,omitempty"`
	Data  map[string]any `json:"data,omitempty"`
	Text  string         `json:"text,omitempty"`
}
