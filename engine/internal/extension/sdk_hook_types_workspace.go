package extension

import "github.com/dsswift/ion/engine/internal/types"

// WorkspaceFileRenamedInfo carries a rename the workspace watcher correlated
// from a removal and a creation of the same file. The absolute paths are
// OS-native; the relative paths are forward-slash separated and relative to
// EngineConfig.WorkingDirectory.
type WorkspaceFileRenamedInfo struct {
	OldPath    string `json:"oldPath"`
	OldRelPath string `json:"oldRelPath"`
	NewPath    string `json:"newPath"`
	NewRelPath string `json:"newRelPath"`
}

// WikiLinkPropagationReport is the payload of the wiki_links_propagated hook:
// the renames one propagation pass handled and every link it rewrote.
type WikiLinkPropagationReport = types.WikiLinkPropagationReport
