package backend

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestMessageEndCarriesPersistedEntryIDs pins the pre-mint contract: the
// UsageEvent (→ engine_message_end) must carry the SAME entry ids the tree
// persists for the assistant message it closes and for the run-opening user
// turn. Consumers re-key their live rows to these ids so a later history
// load (SessionMessage.ID) dedups against them — the root fix for the iOS
// duplicate-interlacing bug.
func TestMessageEndCarriesPersistedEntryIDs(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("hello there", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-entry-id")
	b.StartRun("req-entry-id", types.RunOptions{
		Prompt:           "hi",
		ProjectPath:      tmp,
		Model:            testModel,
		ConversationID:   "conv-entry-id-test",
		EarlyStopEnabled: testEarlyStopDisabled(),
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for exit")
	}

	// Find the usage event that closed the assistant message.
	c.mu.Lock()
	var usage *types.UsageEvent
	for _, ev := range c.normalized {
		if u, ok := ev.Data.(*types.UsageEvent); ok && u.EntryID != "" {
			usage = u
		}
	}
	c.mu.Unlock()
	if usage == nil {
		t.Fatal("no UsageEvent with EntryID emitted")
	}
	if usage.UserEntryID == "" {
		t.Fatal("UsageEvent.UserEntryID is empty")
	}

	// The persisted tree must carry the same ids.
	conv, err := conversation.Load("conv-entry-id-test", "")
	if err != nil {
		t.Fatalf("load persisted conversation: %v", err)
	}
	var userID, assistantID string
	for i := range conv.Entries {
		if conv.Entries[i].Type != conversation.EntryMessage {
			continue
		}
		switch role := entryRole(conv.Entries[i].Data); role {
		case "user":
			if userID == "" {
				userID = conv.Entries[i].ID
			}
		case "assistant":
			assistantID = conv.Entries[i].ID
		}
	}
	if assistantID != usage.EntryID {
		t.Errorf("persisted assistant entry id %q != emitted EntryID %q", assistantID, usage.EntryID)
	}
	if userID != usage.UserEntryID {
		t.Errorf("persisted user entry id %q != emitted UserEntryID %q", userID, usage.UserEntryID)
	}
}

// TestUserTurnPersistedEmittedBeforeStreaming pins the re-key contract for
// runs that never reach a message_end: the run emits a UserTurnPersistedEvent
// carrying the persisted user turn's canonical entry id BEFORE the first
// text chunk. A consumer re-keys its optimistic user row on this event, so a
// cancel or mid-stream failure can no longer leave the row un-re-keyed (the
// history-reload duplicate-user-bubble bug).
func TestUserTurnPersistedEmittedBeforeStreaming(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("hello there", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-utp")
	b.StartRun("req-utp", types.RunOptions{
		Prompt:           "hi",
		ProjectPath:      tmp,
		Model:            testModel,
		ConversationID:   "conv-utp-test",
		EarlyStopEnabled: testEarlyStopDisabled(),
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out waiting for exit")
	}

	c.mu.Lock()
	utpIdx, firstTextIdx := -1, -1
	var utp *types.UserTurnPersistedEvent
	for i, ev := range c.normalized {
		switch d := ev.Data.(type) {
		case *types.UserTurnPersistedEvent:
			if utpIdx == -1 {
				utpIdx = i
				utp = d
			}
		case *types.TextChunkEvent:
			if firstTextIdx == -1 {
				firstTextIdx = i
			}
		}
	}
	c.mu.Unlock()

	if utp == nil {
		t.Fatal("no UserTurnPersistedEvent emitted")
	}
	if utp.EntryID == "" {
		t.Fatal("UserTurnPersistedEvent.EntryID is empty")
	}
	if firstTextIdx != -1 && utpIdx > firstTextIdx {
		t.Errorf("UserTurnPersistedEvent emitted at index %d, after first text chunk at %d — must precede streaming", utpIdx, firstTextIdx)
	}

	// The id must match the persisted user turn's tree-entry id.
	conv, err := conversation.Load("conv-utp-test", "")
	if err != nil {
		t.Fatalf("load persisted conversation: %v", err)
	}
	var userID string
	for i := range conv.Entries {
		if conv.Entries[i].Type == conversation.EntryMessage && entryRole(conv.Entries[i].Data) == "user" {
			userID = conv.Entries[i].ID
			break
		}
	}
	if userID != utp.EntryID {
		t.Errorf("persisted user entry id %q != emitted EntryID %q", userID, utp.EntryID)
	}
}

// entryRole extracts the role from a message entry's data.
func entryRole(data any) string {
	switch d := data.(type) {
	case conversation.MessageData:
		return d.Role
	case *conversation.MessageData:
		return d.Role
	}
	return ""
}
