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
//
// Returns the IDs actually removed, in the order they were deleted — not just
// a count — so a caller can fire a conversation.lifecycle("deleted") event per
// conversation (issue #378, child 04) without re-deriving which of the
// requested IDs actually succeeded when a later ID in the batch errors.
func DeleteStoredExact(dir string, ids []string, activeSessionIDs []string) ([]string, error) {
	if dir == "" {
		dir = DefaultConversationsDir()
	}
	if len(ids) == 0 {
		return nil, fmt.Errorf("no conversation IDs supplied")
	}
	active := make(map[string]struct{}, len(activeSessionIDs))
	for _, id := range activeSessionIDs {
		active[id] = struct{}{}
	}
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if id == "" || id != filepath.Base(id) || strings.Contains(id, string(filepath.Separator)) {
			return nil, fmt.Errorf("invalid conversation ID %q", id)
		}
		if _, ok := active[id]; ok {
			return nil, fmt.Errorf("conversation %q is active", id)
		}
		seen[id] = struct{}{}
	}
	deleted := make([]string, 0, len(seen))
	for id := range seen {
		if err := deleteConversationFiles(dir, id); err != nil {
			utils.LogWithFields(utils.LevelError, "conversation.delete", "exact deletion failed", map[string]any{"conversation_id": id, "error": err.Error()})
			return deleted, fmt.Errorf("delete conversation %q: %w", id, err)
		}
		deleted = append(deleted, id)
	}
	utils.LogWithFields(utils.LevelInfo, "conversation.delete", "exact deletion complete", map[string]any{"conversation_count": len(deleted)})
	return deleted, nil
}
