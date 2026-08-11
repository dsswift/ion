package conversation

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// rehydrateMessageUsage restores internal message metadata that is deliberately
// absent from .llm.jsonl: EntryID (json:"-") and assistant Usage (also
// json:"-"). The split file is authoritative for message CONTENT, while the
// active tree path is authoritative for identity and usage.
//
// Matching is positional on the LLM-visible active path, not by content. Content
// cannot be used: a resolved slash stores raw invocation text in EntryMessage
// while .llm.jsonl stores the expanded prompt. DisplayOnly entries are skipped,
// and EntryCompaction or EntryCleared resets the path exactly as BuildContextPath
// does.
func rehydrateMessageUsage(conv *Conversation) {
	if len(conv.Messages) == 0 || len(conv.Entries) == 0 {
		return
	}

	type metadata struct {
		entryID string
		role    string
		usage   *types.LlmUsage
	}
	path := getContextPathEntries(conv)
	var expected []metadata
	for _, entry := range path {
		switch entry.Type {
		case EntryCompaction:
			// BuildContextPath discards everything before the newest boundary.
			expected = []metadata{{entryID: entry.ID, role: "user"}}
		case EntryCleared:
			// /clear also discards all prior LLM-visible messages, but unlike
			// compaction it injects no synthetic boundary message. Keep metadata
			// aligned with BuildContextPath so post-clear assistant Usage is
			// restored from only the active post-clear tree suffix.
			expected = nil
		case EntryMessage:
			md := asMessageData(entry.Data)
			if md == nil || md.DisplayOnly {
				continue
			}
			expected = append(expected, metadata{entryID: entry.ID, role: md.Role, usage: md.Usage})
		}
	}

	if len(expected) != len(conv.Messages) {
		utils.LogWithFields(utils.LevelWarn, "conversation", "rehydrate metadata path/message count mismatch", map[string]any{
			"conversation_id": conv.ID,
			"path_count":      len(expected),
			"message_count":   len(conv.Messages),
		})
		return
	}
	for i := range conv.Messages {
		if conv.Messages[i].Role != expected[i].role {
			utils.LogWithFields(utils.LevelWarn, "conversation", "rehydrate metadata role mismatch", map[string]any{
				"conversation_id": conv.ID,
				"index":           i,
				"message_role":    conv.Messages[i].Role,
				"entry_role":      expected[i].role,
			})
			return
		}
	}
	for i := range conv.Messages {
		conv.Messages[i].EntryID = expected[i].entryID
		if expected[i].usage != nil {
			conv.Messages[i].Usage = expected[i].usage
		}
	}
}
