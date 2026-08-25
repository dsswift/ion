package conversation

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/utils"
)

// CommitMicroCompaction persists in-place content reductions without adding an
// EntryCompaction boundary. Micro-compaction never removes source messages, so
// inserting a boundary would falsely reset provider context and hide history.
//
// Every non-transient message must retain its tree identity. Losing that
// identity is a metadata-corruption failure, not permission to discard a row.
func CommitMicroCompaction(conv *Conversation) error {
	if conv == nil {
		return fmt.Errorf("commit micro compaction: nil conversation")
	}
	conv.lock()
	defer conv.unlock()

	if len(conv.Entries) == 0 {
		return nil
	}
	entryIndex := make(map[string]int, len(conv.Entries))
	for i := range conv.Entries {
		entryIndex[conv.Entries[i].ID] = i
	}
	active := make(map[string]bool)
	for _, entry := range getContextPathEntriesLocked(conv) {
		active[entry.ID] = true
	}

	type contentUpdate struct {
		entryIndex int
		data       MessageData
	}
	updates := make([]contentUpdate, 0, len(conv.Messages))
	for i := range conv.Messages {
		message := conv.Messages[i]
		if message.Transient {
			continue
		}
		if message.EntryID == "" {
			return fmt.Errorf("commit micro compaction: message at index %d has no entry identity", i)
		}
		if !active[message.EntryID] {
			return fmt.Errorf("commit micro compaction: message entry %q is not on active path", message.EntryID)
		}
		idx, ok := entryIndex[message.EntryID]
		if !ok {
			return fmt.Errorf("commit micro compaction: message entry %q not found", message.EntryID)
		}
		entryType := conv.Entries[idx].Type
		if IsCompactBoundary(message) {
			if entryType != EntryCompaction {
				return fmt.Errorf("commit micro compaction: boundary entry %q has type %q, want compaction", message.EntryID, entryType)
			}
			// A hard-compaction boundary is already durable metadata. It has no
			// MessageData to update, and micro-compaction must retain it as-is.
			continue
		}
		if entryType != EntryMessage {
			return fmt.Errorf("commit micro compaction: message entry %q has type %q, want message", message.EntryID, entryType)
		}
		data := asMessageData(conv.Entries[idx].Data)
		if data == nil {
			return fmt.Errorf("commit micro compaction: message data %q cannot be decoded", message.EntryID)
		}
		data.LlmContent = message.Content
		updates = append(updates, contentUpdate{entryIndex: idx, data: *data})
	}
	for _, update := range updates {
		conv.Entries[update.entryIndex].Data = update.data
	}
	utils.LogWithFields(utils.LevelInfo, "conversation.compact", "micro compaction committed to tree", map[string]any{
		"conversation_id": conv.ID,
		"message_count":   len(conv.Messages),
		"updated_entries": len(updates),
	})
	return nil
}
