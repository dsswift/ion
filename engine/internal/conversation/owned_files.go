package conversation

import (
	"path/filepath"
	"strings"
)

// A conversation owns one folder beside its `.llm.jsonl` / `.tree.jsonl`
// pair: `<conversationsDir>/<id>/`. Everything that belongs to that one
// conversation lives under it, so moving or deleting the conversation moves
// or deletes exactly its files and nothing another conversation uses:
//
//	<id>/images/        content-addressed images (image_store.go)
//	<id>/plans/         plan files the engine writes for this conversation
//	<id>/attachments/   files attached to it that were copied in (fork, transfer)
//
// Spilled tool output is the one per-conversation store that predates this
// folder and lives beside it, at `<conversationsDir>/tool-results/<id>/`
// (tool_result_storage.go).

// OwnedDir is the folder conversation convID owns.
func OwnedDir(convID string) string {
	return filepath.Join(resolveDir(convID), convID)
}

// PlansDir is where the engine writes plan files for convID.
func PlansDir(convID string) string {
	return filepath.Join(OwnedDir(convID), "plans")
}

// AttachmentsDir is where files attached to convID are copied in.
func AttachmentsDir(convID string) string {
	return filepath.Join(OwnedDir(convID), "attachments")
}

// ToolResultsDir is where convID's oversized tool results are spilled.
func ToolResultsDir(convID string) string {
	return filepath.Join(resolveDir(convID), "tool-results", convID)
}

// IsOwnedPlanPath reports whether path is a plan file inside some
// conversation's own plans folder: `<root>/<id>/plans/<file>`, where root is
// the conversations directory or a partition beneath it. The check is on
// the path's shape, not on a particular conversation, so the plan-content
// reader and the plan-mode write gate can accept it without knowing which
// conversation a session is bound to.
func IsOwnedPlanPath(path string) bool {
	root := DefaultConversationsDir()
	if root == "" || path == "" {
		return false
	}
	clean := filepath.Clean(path)
	plans := filepath.Dir(clean)
	if filepath.Base(plans) != "plans" {
		return false
	}
	convFolder := filepath.Dir(plans)
	id := filepath.Base(convFolder)
	if id == "" || id == "." || id == "tool-results" || strings.HasPrefix(id, ".") {
		return false
	}
	parent := filepath.Dir(convFolder)
	if isWithin(root, parent) {
		return true
	}
	// Callers resolve symlinks on the path before asking (so a link inside a
	// plans folder cannot point outside it); resolve the root the same way,
	// or /var vs /private/var on macOS would refuse a genuine owned plan.
	if resolved, err := filepath.EvalSymlinks(root); err == nil && resolved != root {
		return isWithin(resolved, parent)
	}
	return false
}

// isWithin reports whether path is root or lies beneath it, testing the
// ".." segment boundary rather than a bare prefix.
func isWithin(root, path string) bool {
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(path))
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}
