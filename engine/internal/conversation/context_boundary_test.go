package conversation

import (
	"testing"
)

// TestHasModelVisibleHistory pins the boundary predicate that the slash
// model-tier gate depends on. The distinction it must draw is "would switching
// models here re-send anything to the provider" — so it follows the context
// path, not the raw entry count.
func TestHasModelVisibleHistory(t *testing.T) {
	t.Run("nil conversation is a fresh boundary", func(t *testing.T) {
		if HasModelVisibleHistory(nil) {
			t.Error("nil conversation reported history; want fresh")
		}
	})

	t.Run("new conversation is a fresh boundary", func(t *testing.T) {
		conv := CreateConversation("fresh-1", "sys", "model")

		if HasModelVisibleHistory(conv) {
			t.Error("new conversation reported history; want fresh")
		}
	})

	t.Run("a user message is history", func(t *testing.T) {
		conv := CreateConversation("has-history-1", "sys", "model")
		AddUserMessage(conv, "plan the change")

		if !HasModelVisibleHistory(conv) {
			t.Error("conversation with a user message reported fresh; want history")
		}
	})

	// The load-bearing case. After /clear the tree still holds every entry,
	// so any predicate written against the entry count would wrongly report
	// history and would permanently decline a command's tier on a cleared
	// conversation.
	t.Run("clear returns the conversation to a fresh boundary", func(t *testing.T) {
		conv := CreateConversation("cleared-1", "sys", "model")
		AddUserMessage(conv, "first turn")
		AddUserMessage(conv, "second turn")

		conv.Messages = nil
		AppendEntry(conv, EntryCleared, ClearedData{})

		if HasModelVisibleHistory(conv) {
			t.Error("cleared conversation reported history; want fresh")
		}
		if len(conv.Entries) == 0 {
			t.Fatal("clear removed tree entries; the predicate must be reading the context path, not the tree")
		}
	})

	t.Run("a message after a clear is history again", func(t *testing.T) {
		conv := CreateConversation("cleared-then-used-1", "sys", "model")
		AddUserMessage(conv, "before clear")
		conv.Messages = nil
		AppendEntry(conv, EntryCleared, ClearedData{})
		AddUserMessage(conv, "after clear")

		if !HasModelVisibleHistory(conv) {
			t.Error("message after clear reported fresh; want history")
		}
	})
}
