package conversation

import (
	"github.com/dsswift/ion/engine/internal/types"
)

// AddUserMessageWithBackgroundWork persists an engine-owned completion result
// atomically with its classification and structured delivery metadata. The
// LLM-visible content remains the single source of the exact delivered text.
func AddUserMessageWithBackgroundWork(conv *Conversation, content any, work types.BackgroundWorkInfo) *SessionEntry {
	blocks := toContentBlocks(content)
	conv.lock()
	defer conv.unlock()
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: blocks})
	if conv.Entries == nil {
		return nil
	}
	entry := appendEntryLocked(conv, EntryMessage, MessageData{
		Role:            "user",
		Content:         blocks,
		InjectionKind:   work.Kind,
		MachineAuthored: types.InjectionKind(work.Kind).IsMachineToMachine(),
		BackgroundWork:  &work,
	}, "")
	conv.Messages[len(conv.Messages)-1].EntryID = entry.ID
	return entry
}
