package conversation

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// DeleteStoredExact removes every persisted file for the supplied conversation
// IDs. Active session IDs are refused as a single operation: partial deletion
// would leave callers unable to know which conversation state remains valid.
func DeleteStoredExact(dir string, ids []string, activeSessionIDs []string) (int, error) {
	if dir == "" {
		dir = DefaultConversationsDir()
	}
	if len(ids) == 0 {
		return 0, fmt.Errorf("no conversation IDs supplied")
	}
	active := make(map[string]struct{}, len(activeSessionIDs))
	for _, id := range activeSessionIDs {
		active[id] = struct{}{}
	}
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if id == "" || id != filepath.Base(id) || strings.Contains(id, string(filepath.Separator)) {
			return 0, fmt.Errorf("invalid conversation ID %q", id)
		}
		if _, ok := active[id]; ok {
			return 0, fmt.Errorf("conversation %q is active", id)
		}
		seen[id] = struct{}{}
	}
	deleted := 0
	for id := range seen {
		if err := deleteConversationFiles(dir, id); err != nil {
			utils.LogWithFields(utils.LevelError, "conversation.delete", "exact deletion failed", map[string]any{"conversation_id": id, "error": err.Error()})
			return deleted, fmt.Errorf("delete conversation %q: %w", id, err)
		}
		deleted++
	}
	utils.LogWithFields(utils.LevelInfo, "conversation.delete", "exact deletion complete", map[string]any{"conversation_count": deleted})
	return deleted, nil
}
