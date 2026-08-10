package session

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/utils"
)

func rootDispatchOutboxPath(conversationID string) string {
	return filepath.Join(conversation.DefaultConversationsDir(), conversationID+".dispatch-outbox.json")
}

func loadRootDispatchOutbox(conversationID string) []rootDispatchCompletion {
	if conversationID == "" {
		return nil
	}
	data, err := os.ReadFile(rootDispatchOutboxPath(conversationID))
	if err != nil {
		if !os.IsNotExist(err) {
			utils.LogWithFields(utils.LevelWarn, "session.dispatch_delivery", "root dispatch outbox read failed", map[string]any{"conversation_id": conversationID, "error": err.Error()})
		}
		return nil
	}
	var records []rootDispatchCompletion
	if err := json.Unmarshal(data, &records); err != nil {
		utils.LogWithFields(utils.LevelError, "session.dispatch_delivery", "root dispatch outbox decode failed", map[string]any{"conversation_id": conversationID, "error": err.Error()})
		return nil
	}
	return records
}

// persistRootDispatchOutbox atomically replaces the durable FIFO record. It is
// called before every delivery attempt and after every acknowledgement.
func persistRootDispatchOutbox(conversationID string, records []rootDispatchCompletion) error {
	if conversationID == "" {
		return fmt.Errorf("root dispatch outbox requires a conversation id")
	}
	path := rootDispatchOutboxPath(conversationID)
	if len(records) == 0 {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove root dispatch outbox: %w", err)
		}
		return nil
	}
	data, err := json.Marshal(records)
	if err != nil {
		return fmt.Errorf("marshal root dispatch outbox: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create root dispatch outbox directory: %w", err)
	}
	temp := path + ".tmp"
	if err := os.WriteFile(temp, data, 0o600); err != nil {
		return fmt.Errorf("write root dispatch outbox: %w", err)
	}
	if err := os.Rename(temp, path); err != nil {
		_ = os.Remove(temp) //nolint:errcheck // cleanup after failed atomic replace
		return fmt.Errorf("replace root dispatch outbox: %w", err)
	}
	return nil
}
