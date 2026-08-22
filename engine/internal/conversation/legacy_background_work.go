package conversation

import "github.com/dsswift/ion/engine/internal/types"

// legacyBackgroundWork upgrades only the historical shape this feature
// replaced: an unclassified user entry immediately followed by a steer marker.
// A user message that merely resembles task output remains a user message.
func legacyBackgroundWork(conv *Conversation, entry SessionEntry, data *MessageData) *types.BackgroundWorkInfo {
	if data == nil || data.BackgroundWork != nil || data.InjectionKind != "" || !hasDirectSteerMarker(conv, entry.ID) {
		return nil
	}
	blocks := contentToBlocks(data.Content)
	text := ""
	for _, block := range blocks {
		if block.Type == "text" {
			text += block.Text
		}
	}
	info, ok := types.ParseLegacyBackgroundTaskCompletion(text)
	if !ok {
		return nil
	}
	return &info
}

func hasDirectSteerMarker(conv *Conversation, entryID string) bool {
	for _, entry := range conv.Entries {
		if entry.Type == EntrySteerMarker && entry.ParentID != nil && *entry.ParentID == entryID {
			return true
		}
	}
	return false
}
