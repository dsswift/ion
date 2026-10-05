package extension

import "github.com/dsswift/ion/engine/internal/workspaces"

// Payload types for the context-file hooks: context_discover, context_load,
// instruction_load, and context_inject.

// ContextDiscoverInfo describes a context file discovery event. The hook
// fires for every candidate that exists on disk, duplicates included, so a
// handler sees each file the engine skips and why.
//
// Field stability: new fields may be added with zero-value defaults; existing
// fields must not be removed or renamed.
type ContextDiscoverInfo struct {
	Path   string `json:"path"`
	Source string `json:"source"`
	// DuplicateOf is the path of an already-loaded file this candidate
	// duplicates. Empty when the candidate is not a duplicate. A duplicate is
	// skipped whatever the handler returns.
	DuplicateOf string `json:"duplicateOf,omitempty"`
	// DuplicateReason is "symlink" (resolves to a loaded file) or "content"
	// (byte-identical to a loaded file). Empty when DuplicateOf is empty.
	DuplicateReason string `json:"duplicateReason,omitempty"`
}

// ContextLoadInfo describes a context file load event.
type ContextLoadInfo struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Source  string `json:"source"`
}

// ContextInjectInfo is the payload for the context_inject hook.
type ContextInjectInfo struct {
	WorkingDirectory string                    `json:"workingDirectory"`
	DiscoveredPaths  []string                  `json:"discoveredPaths"`
	Workspace        *workspaces.PromptContext `json:"workspace,omitempty"`
}

// ContextEntry is a single piece of context content to inject into the system prompt.
type ContextEntry struct {
	Label   string `json:"label"`   // identifier shown in prompt (e.g. file path)
	Content string `json:"content"` // raw content to inject
}
