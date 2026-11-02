package session

import (
	"path/filepath"

	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/utils"
)

// withSessionExtensions appends the engine's configured session extensions
// (engine.json sessionExtensions) to a session's own extension list. An
// entry the session already names, by its expanded and cleaned path, is
// skipped so no extension is loaded twice.
func (m *Manager) withSessionExtensions(key string, extensions []string) []string {
	m.mu.RLock()
	var configured []string
	if m.config != nil {
		configured = m.config.SessionExtensions
	}
	m.mu.RUnlock()
	if len(configured) == 0 {
		return extensions
	}
	out := append([]string(nil), extensions...)
	seen := make(map[string]struct{}, len(out)+len(configured))
	for _, ext := range out {
		seen[extensionIdentity(ext)] = struct{}{}
	}
	added := 0
	for _, ext := range configured {
		id := extensionIdentity(ext)
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, ext)
		added++
	}
	utils.LogWithFields(utils.LevelDebug, "session", "session extensions applied", map[string]any{"key": key, "configured": len(configured), "added": added, "count": len(out)})
	return out
}

func extensionIdentity(path string) string {
	return filepath.Clean(ionconfig.ExpandTilde(path))
}
