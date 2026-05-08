package conversation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsInternalMessage(t *testing.T) {
	tests := []struct {
		content  string
		expected bool
	}{
		{"[SYSTEM] Plan mode still active", true},
		{"[SYSTEM] You are approaching your turn limit.", true},
		{"Continue from where you left off.", true},
		{"Hello, how are you?", false},
		{"", false},
		{"[SYSTEM]no space after bracket", false},
		{"continue from where you left off.", false}, // case-sensitive
	}

	for _, tc := range tests {
		t.Run(tc.content, func(t *testing.T) {
			if got := isInternalMessage(tc.content); got != tc.expected {
				t.Errorf("isInternalMessage(%q) = %v, want %v", tc.content, got, tc.expected)
			}
		})
	}
}

func TestAddTransientUserMessage(t *testing.T) {
	conv := CreateConversation("test-transient", "system", "model")
	AddTransientUserMessage(conv, "[SYSTEM] test transient")

	// Message should be in in-memory Messages
	if len(conv.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(conv.Messages))
	}
	if conv.Messages[0].Role != "user" {
		t.Errorf("expected role 'user', got %q", conv.Messages[0].Role)
	}

	// Entry should NOT be in Entries (not persisted)
	if len(conv.Entries) != 0 {
		t.Errorf("expected 0 entries (transient), got %d", len(conv.Entries))
	}
}

func TestAddTransientVsPersisted(t *testing.T) {
	conv := CreateConversation("test-mix", "system", "model")

	// Add a normal persisted message
	AddUserMessage(conv, "Hello")
	// Add a transient message
	AddTransientUserMessage(conv, "[SYSTEM] internal steering")
	// Add another normal message
	AddUserMessage(conv, "World")

	// In-memory: 3 messages
	if len(conv.Messages) != 3 {
		t.Fatalf("expected 3 in-memory messages, got %d", len(conv.Messages))
	}

	// Entries: only 2 (transient not persisted)
	if len(conv.Entries) != 2 {
		t.Errorf("expected 2 entries (transient excluded), got %d", len(conv.Entries))
	}
}

func TestFlattenEntriesTagsInternalMessages(t *testing.T) {
	conv := CreateConversation("test-flatten", "system", "model")

	AddUserMessage(conv, "Hello")
	AddUserMessage(conv, "[SYSTEM] Plan mode still active (see full instructions).")
	AddUserMessage(conv, "Continue from where you left off.")
	AddUserMessage(conv, "Normal follow-up")

	msgs := flattenEntries(conv)

	expected := []struct {
		content  string
		internal bool
	}{
		{"Hello", false},
		{"[SYSTEM] Plan mode still active (see full instructions).", true},
		{"Continue from where you left off.", true},
		{"Normal follow-up", false},
	}

	if len(msgs) != len(expected) {
		t.Fatalf("expected %d messages, got %d", len(expected), len(msgs))
	}

	for i, e := range expected {
		if msgs[i].Content != e.content {
			t.Errorf("msg[%d] content = %q, want %q", i, msgs[i].Content, e.content)
		}
		if msgs[i].Internal != e.internal {
			t.Errorf("msg[%d] internal = %v, want %v", i, msgs[i].Internal, e.internal)
		}
	}
}

func TestLoadMessagesTagsInternal(t *testing.T) {
	// Create a conversation, save it, then load and verify internal tagging
	dir := t.TempDir()
	conv := CreateConversation("test-load-internal", "system", "model")

	AddUserMessage(conv, "Hello")
	AddUserMessage(conv, "[SYSTEM] You are approaching your turn limit.")

	if err := Save(conv, dir); err != nil {
		t.Fatal(err)
	}

	msgs, err := LoadMessages("test-load-internal", dir)
	if err != nil {
		t.Fatal(err)
	}

	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if msgs[0].Internal {
		t.Error("msg[0] should not be internal")
	}
	if !msgs[1].Internal {
		t.Error("msg[1] should be internal")
	}
}

func TestTransientMessageNotInSavedFile(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("test-transient-save", "system", "model")

	AddUserMessage(conv, "Hello")
	AddTransientUserMessage(conv, "[SYSTEM] transient steering")
	AddUserMessage(conv, "World")

	if err := Save(conv, dir); err != nil {
		t.Fatal(err)
	}

	// Reload and verify transient message is absent
	msgs, err := LoadMessages("test-transient-save", dir)
	if err != nil {
		t.Fatal(err)
	}

	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages (transient excluded), got %d", len(msgs))
	}
	if msgs[0].Content != "Hello" {
		t.Errorf("msg[0] = %q, want 'Hello'", msgs[0].Content)
	}
	if msgs[1].Content != "World" {
		t.Errorf("msg[1] = %q, want 'World'", msgs[1].Content)
	}

	// Verify the file on disk doesn't contain the transient message
	data, err := os.ReadFile(filepath.Join(dir, "test-transient-save.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	content := string(data)
	if strings.Contains(content, "transient steering") {
		t.Error("transient message should not be in saved file")
	}
}
