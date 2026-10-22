package session

import (
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// renameSettings is the rename-tracking configuration resolved for one
// workspace watcher.
type renameSettings struct {
	// enabled turns rename tracking on.
	enabled bool
	// extensions are the tracked file extensions, lower case with a leading
	// dot.
	extensions []string
}

// resolveRenameSettings reads rename tracking from the workspace block of the
// engine config. Nil-safe: an absent config or block yields the compiled
// defaults.
func (m *Manager) resolveRenameSettings() renameSettings {
	var ws *types.WorkspaceConfig
	if m.config != nil {
		ws = m.config.GetWorkspace()
	}
	return renameSettings{
		enabled:    ws.RenameTrackingEnabled(),
		extensions: ws.RenameFileExtensions(),
	}
}

func (r renameSettings) fingerprint() string {
	if !r.enabled {
		return "off"
	}
	return "track:" + strings.Join(r.extensions, ",")
}

// tracks reports whether a root-relative path names a file whose renames are
// reported.
func (r renameSettings) tracks(rel string) bool {
	lower := strings.ToLower(rel)
	for _, ext := range r.extensions {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}
