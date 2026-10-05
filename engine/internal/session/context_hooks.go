package session

import (
	ioncontext "github.com/dsswift/ion/engine/internal/context"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// contextWalkHooks adapts the session's extension group to the context
// walker's per-file seams, so context_discover and context_load fire for every
// instruction file the root walk considers. A session with no extensions gets
// zero hooks and the walker runs unobserved.
func (m *Manager) contextWalkHooks(s *engineSession, key string) ioncontext.WalkHooks {
	m.mu.RLock()
	group := s.extGroup
	m.mu.RUnlock()
	if group == nil || group.IsEmpty() {
		utils.LogWithFields(utils.LevelDebug, "session.context", "context walk hooks skipped: no extensions loaded", map[string]any{"key": key})
		return ioncontext.WalkHooks{}
	}
	ctx := m.newExtContext(s, key)
	return ioncontext.WalkHooks{
		OnDiscover: func(ev ioncontext.DiscoverEvent) bool {
			reject, err := group.FireContextDiscover(ctx, extension.ContextDiscoverInfo{
				Path: ev.Path, Source: ev.Source, DuplicateOf: ev.DuplicateOf, DuplicateReason: ev.DuplicateReason,
			})
			if err != nil {
				utils.LogWithFields(utils.LevelWarn, "session.context", "context_discover hook failed; keeping file", map[string]any{"key": key, "path": ev.Path, "error": err})
				return false
			}
			utils.LogWithFields(utils.LevelDebug, "session.context", "context_discover decided", map[string]any{"key": key, "path": ev.Path, "reject": reject, "duplicate_of": ev.DuplicateOf})
			return reject
		},
		OnLoad: func(path, content, source string) (string, bool) {
			out, reject, err := group.FireContextLoad(ctx, extension.ContextLoadInfo{Path: path, Content: content, Source: source})
			if err != nil {
				utils.LogWithFields(utils.LevelWarn, "session.context", "context_load hook failed; keeping original content", map[string]any{"key": key, "path": path, "error": err})
				return content, false
			}
			if reject {
				return "", true
			}
			if out == "" {
				// No handler offered content: keep the file as loaded.
				return content, false
			}
			return out, false
		},
	}
}
