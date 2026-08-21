package conversation

import (
	"github.com/dsswift/ion/engine/internal/types"
)

// compactionMetaFromData reconstructs the exact typed boundary persisted in a
// tree entry. Keeping this conversion in one place prevents branch rebuilds and
// sidecar saves from silently dropping optional boundary metadata.
func compactionMetaFromData(data CompactionData) CompactMeta {
	return CompactMeta{
		Trigger:            data.Strategy,
		MessagesSummarized: data.MessagesSummarized,
		MessagesBefore:     data.MessagesBefore,
		MessagesAfter:      data.MessagesAfter,
		ClearedBlocks:      data.ClearedBlocks,
		TokensBefore:       data.TokensBefore,
		Summary:            data.Summary,
		FactCount:          data.FactCount,
		RecentFiles:        data.RecentFiles,
		RestoredSkills:     data.RestoredSkills,
	}
}

// buildContextPathLocked is BuildContextPath's body; callers must hold conv.mu.
func buildContextPathLocked(conv *Conversation) []types.LlmMessage {
	if conv.Entries == nil || conv.LeafID == nil {
		return conv.Messages
	}

	path := getContextPathEntriesLocked(conv)
	var messages []types.LlmMessage
	for _, entry := range path {
		switch entry.Type {
		case EntryMessage:
			messageData := asMessageData(entry.Data)
			if messageData == nil || messageData.DisplayOnly {
				continue
			}
			content := messageData.Content
			if messageData.LlmContent != nil {
				content = messageData.LlmContent
			}
			message := types.LlmMessage{Role: messageData.Role, Content: content, EntryID: entry.ID}
			if messageData.Role == "assistant" && messageData.Usage != nil {
				message.Usage = messageData.Usage
			}
			messages = append(messages, message)
		case EntryCleared:
			// A clear remains visible in the transcript tree but is not model
			// context. It removes every preceding message, including its DisplayOnly
			// /clear invocation, and emits no synthetic provider message.
			messages = nil
		case EntryCompaction:
			data := asCompactionData(entry.Data)
			messages = nil
			if data == nil {
				continue
			}
			boundary := BuildCompactBoundaryMessage(compactionMetaFromData(*data))
			boundary.EntryID = entry.ID
			messages = append(messages, boundary)
		default:
			continue
		}
	}
	return messages
}
