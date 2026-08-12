package conversation

import "github.com/dsswift/ion/engine/internal/utils"

// repairInvalidZeroDropCompactions removes malformed compaction entries that
// claim a zero-message cut. A valid hard compaction always drops at least one
// source message and inserts its boundary before the retained suffix. A zero
// drop boundary therefore cannot carry a legitimate summary or reset provider
// context. It is safe to remove only that boundary node, reconnecting each
// child to its original parent.
func repairInvalidZeroDropCompactions(conv *Conversation, report *TreeRepairReport) {
	if conv == nil || len(conv.Entries) == 0 {
		return
	}

	for index := 0; index < len(conv.Entries); {
		entry := conv.Entries[index]
		data := asCompactionData(entry.Data)
		if entry.Type != EntryCompaction || data == nil || data.MessagesSummarized != 0 || data.MessagesBefore == 0 {
			index++
			continue
		}

		// Historical malformed records predate MessagesSummarized. Their count
		// fields expose the same contradiction: messagesAfter equals messagesBefore
		// plus the injected boundary, while FirstKeptEntryID names a direct child.
		zeroDrop := data.MessagesAfter == data.MessagesBefore+1 && data.FirstKeptEntryID != ""
		if !zeroDrop {
			index++
			continue
		}

		for childIndex := range conv.Entries {
			child := &conv.Entries[childIndex]
			if child.ParentID == nil || *child.ParentID != entry.ID {
				continue
			}
			if entry.ParentID == nil {
				child.ParentID = nil
			} else {
				parentID := *entry.ParentID
				child.ParentID = &parentID
			}
		}
		if conv.LeafID != nil && *conv.LeafID == entry.ID {
			if entry.ParentID == nil {
				conv.LeafID = nil
			} else {
				parentID := *entry.ParentID
				conv.LeafID = &parentID
			}
		}
		conv.Entries = append(conv.Entries[:index], conv.Entries[index+1:]...)
		report.InvalidCompactionsRepaired++
		utils.LogWithFields(utils.LevelWarn, "conversation", "tree repair: removed invalid zero-drop compaction", map[string]any{
			"conversation_id": conv.ID,
			"entry_id":        entry.ID,
			"messages_before": data.MessagesBefore,
			"messages_after":  data.MessagesAfter,
			"first_kept_id":   data.FirstKeptEntryID,
		})
	}
}
