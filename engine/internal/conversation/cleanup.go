package conversation

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// CleanupStored removes conversation files that are older than maxAgeDays
// (by file mtime) and not in the excludeIDs set. Conversations with custom
// labels (user-renamed) are preserved. When dryRun is true, no files are
// deleted but the count of would-be-deleted conversations is returned.
//
// activeSessionIDs is an additional server-side safety guard: conversations
// with IDs matching any active engine session are never deleted, independent
// of the client-supplied excludeIDs.
func CleanupStored(dir string, maxAgeDays int, excludeIDs []string, activeSessionIDs []string, dryRun bool) (int, error) {
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return 0, err
		}
		dir = filepath.Join(home, ".ion", "conversations")
	}

	cutoff := time.Now().AddDate(0, 0, -maxAgeDays)
	utils.LogWithFields(utils.LevelInfo, "conversation.cleanup", "start", map[string]any{
		"path": dir, "max": maxAgeDays, "count": len(excludeIDs), "attempt": len(activeSessionIDs),
	})

	// Build exclude set from both client and server sources.
	exclude := make(map[string]bool, len(excludeIDs)+len(activeSessionIDs))
	for _, id := range excludeIDs {
		exclude[id] = true
	}
	for _, id := range activeSessionIDs {
		exclude[id] = true
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, fmt.Errorf("read conversations dir: %w", err)
	}

	// Collect unique conversation IDs from .llm.jsonl files (canonical for
	// new-format conversations). Also collect legacy .jsonl IDs. Mirrors the
	// dedup logic in ListStored.
	type candidate struct {
		id    string
		mtime time.Time
	}
	var candidates []candidate
	seen := make(map[string]bool)

	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		var id string
		switch {
		case strings.HasSuffix(name, ".llm.jsonl"):
			id = strings.TrimSuffix(name, ".llm.jsonl")
		case strings.HasSuffix(name, ".jsonl") &&
			!strings.HasSuffix(name, ".tree.jsonl") &&
			!strings.HasSuffix(name, ".llm.jsonl"):
			id = strings.TrimSuffix(name, ".jsonl")
		default:
			continue
		}

		if seen[id] || exclude[id] {
			continue
		}
		seen[id] = true

		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			candidates = append(candidates, candidate{id: id, mtime: info.ModTime()})
		}
	}

	// Filter out conversations with custom labels.
	var toDelete []string
	for _, c := range candidates {
		if hasCustomLabel(dir, c.id) {
			utils.LogWithFields(utils.LevelDebug, "conversation.cleanup", "skip labeled", map[string]any{"conversation_id": c.id})
			continue
		}
		toDelete = append(toDelete, c.id)
	}

	if dryRun {
		utils.LogWithFields(utils.LevelInfo, "conversation.cleanup", "dry-run would delete", map[string]any{"count": len(toDelete)})
		return len(toDelete), nil
	}

	deleted := 0
	for _, id := range toDelete {
		if err := deleteConversationFiles(dir, id); err != nil {
			utils.LogWithFields(utils.LevelError, "conversation.cleanup", "delete failed", map[string]any{"conversation_id": id, "error": err.Error()})
			continue
		}
		deleted++
	}

	utils.LogWithFields(utils.LevelInfo, "conversation.cleanup", "done", map[string]any{"count": deleted})
	return deleted, nil
}

// hasCustomLabel checks whether a conversation has a user-set label by
// scanning the .tree.jsonl for a label entry. Returns false if the file
// doesn't exist or can't be read.
func hasCustomLabel(dir, id string) bool {
	treePath := filepath.Join(dir, id+".tree.jsonl")
	data, err := os.ReadFile(treePath)
	if err != nil {
		return false
	}
	// Quick string scan rather than full JSON parse for performance.
	// Label entries contain: "type":"label"
	return strings.Contains(string(data), `"type":"label"`)
}

// deleteConversationFiles removes all files for a conversation ID.
func deleteConversationFiles(dir, id string) error {
	suffixes := []string{".tree.jsonl", ".llm.jsonl", ".memory.md", ".jsonl", ".json"}
	var lastErr error
	removed := 0
	for _, suffix := range suffixes {
		path := filepath.Join(dir, id+suffix)
		if err := os.Remove(path); err != nil {
			if !os.IsNotExist(err) {
				lastErr = err
				utils.LogWithFields(utils.LevelError, "conversation.cleanup", "remove failed", map[string]any{"path": path, "error": err.Error()})
			}
		} else {
			removed++
			utils.LogWithFields(utils.LevelDebug, "conversation.cleanup", "removed", map[string]any{"path": path})
		}
	}
	if removed > 0 {
		utils.LogWithFields(utils.LevelInfo, "conversation.cleanup", "deleted", map[string]any{"conversation_id": id, "count": removed})
	}
	return lastErr
}
