package session

import (
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/utils"
)

// PlanDirsForWorkingDir returns the set of valid plan directories for a
// session with the given working directory. Used by the get_plan_content
// server handler to enforce the path-containment security check without
// needing to know which backend the session uses.
//
// Because the backend type is not available at the server layer, we return
// both candidate directories:
//   - <workingDir>/.ion/plans/ (used by CLI and Hybrid backends when
//     workingDir is non-empty)
//   - ~/.ion/plans/ (the fallback for a session with no conversation yet, and
//     where plans lived before each conversation owned its own)
//
// A conversation's own plans folder (<conversationsDir>/<id>/plans/, where
// every other backend writes its plans) is not a fixed directory, so callers
// accept it separately with conversation.IsOwnedPlanPath.
//
// A plan file path is valid if it is contained within ANY of the returned
// directories. Callers should use filepath.Rel to test containment, testing
// the ".." path-segment boundary rather than a bare "had a .. prefix" — a
// bare HasPrefix(rel, "..") over-rejects a legitimate file literally named
// "..foo". Symlinks should be resolved (filepath.EvalSymlinks) before the
// test so a symlink inside the dir that targets outside it cannot defeat it:
//
//	for _, dir := range PlanDirsForWorkingDir(workingDir) {
//	    rel, err := filepath.Rel(dir, path)
//	    if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
//	        // path is inside dir — accept
//	    }
//	}
//
// The function never returns a nil slice; at minimum it returns the home
// plans directory. An empty workingDir produces only the home entry.
func PlanDirsForWorkingDir(workingDir string) []string {
	homePlans := filepath.Join(utils.IonDir(), "plans")

	if workingDir != "" {
		return []string{
			filepath.Join(workingDir, ".ion", "plans"),
			homePlans,
		}
	}
	return []string{homePlans}
}

// SessionPlanFilePath returns the plan file the session identified by key has
// open, or "" when it has none or no such session exists. A fork reports its
// own copy here, so the client can show the fork's plan, not the source's.
func (m *Manager) SessionPlanFilePath(key string) string {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		return ""
	}
	return s.planFilePath
}
