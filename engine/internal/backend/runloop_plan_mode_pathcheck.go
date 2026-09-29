package backend

import (
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/utils"
)

// planDirsForWorkingDir returns the set of recognized plan directories for a
// run with the given working directory. It is a backend-package copy of
// session.PlanDirsForWorkingDir — the backend package cannot import session
// (session imports backend, so importing back would create a cycle), so the
// small, stable list of plan roots is duplicated here. The two must stay in
// sync: a path is "plan-shaped" only if it lives under one of these roots.
//
// Roots returned:
//   - <workingDir>/.ion/plans/ (used by CLI and Hybrid backends when
//     workingDir is non-empty)
//   - ~/.ion/plans/ (the fallback for a session with no conversation yet, and
//     where plans lived before each conversation owned its own)
//
// A conversation's own plans folder (<conversationsDir>/<id>/plans/) is not
// a fixed root, so isPlanShapedPath checks it by shape
// (conversation.IsOwnedPlanPath) instead of listing it here.
//
// An empty workingDir produces only the home entry. The function never
// returns nil; at minimum it returns the home plans directory.
func planDirsForWorkingDir(workingDir string) []string {
	homePlans := filepath.Join(utils.IonDir(), "plans")

	if workingDir != "" {
		return []string{
			filepath.Join(workingDir, ".ion", "plans"),
			homePlans,
		}
	}
	return []string{homePlans}
}

// isPlanShapedPath reports whether targetPath lives inside any recognized
// plan directory for workingDir. It mirrors the containment test documented
// in session/plan_dirs.go: resolve symlinks first (so a symlink inside the
// dir that targets outside it cannot defeat the check), then use filepath.Rel
// and test the ".." path-segment boundary rather than a bare HasPrefix(rel,
// "..") — a bare prefix test over-rejects a legitimate file literally named
// "..foo".
//
// A path that does not yet exist on disk (the common case — the model is
// about to create the stray plan file) cannot be EvalSymlinks'd, so we fall
// back to resolving the parent directory and re-joining the base name. This
// keeps the symlink-resolution guarantee for the directory portion while
// still classifying a not-yet-created file.
func isPlanShapedPath(targetPath, workingDir string) bool {
	resolved := resolveForContainment(targetPath)
	if conversation.IsOwnedPlanPath(resolved) {
		return true
	}
	for _, dir := range planDirsForWorkingDir(workingDir) {
		resolvedDir := resolveForContainment(dir)
		rel, err := filepath.Rel(resolvedDir, resolved)
		if err != nil {
			continue
		}
		if rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// resolveForContainment returns a symlink-resolved, cleaned absolute form of
// path suitable for the filepath.Rel containment test. When the path itself
// does not exist (a file the model is about to create), it resolves the
// parent directory and re-joins the base name so the directory portion still
// gets symlink resolution. Falls back to filepath.Clean when even the parent
// cannot be resolved.
func resolveForContainment(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	dir := filepath.Dir(path)
	base := filepath.Base(path)
	if resolvedDir, err := filepath.EvalSymlinks(dir); err == nil {
		return filepath.Join(resolvedDir, base)
	}
	return filepath.Clean(path)
}
