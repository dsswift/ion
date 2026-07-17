package types

// PluginInfo is a summary of one installed plugin, carried in plugin operation
// results returned via ServerResult data. Not a NormalizedEvent variant — plugin
// management communicates via the existing sendResult/ServerResult path.
type PluginInfo struct {
	Name        string `json:"name"`
	Source      string `json:"source"`
	Version     string `json:"version"`
	InstalledAt string `json:"installedAt"` // RFC3339
}
