package extension

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
