package conversation

import (
	"bytes"
	"os"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestAppendDispatchError_DurableDisplayOnlyHistory pins the complete contract
// for a dispatch failure discovered after the child backend's final save:
//
//   - the typed dispatch_error entry survives Save → Load,
//   - historical client reload receives one system-role Error row,
//   - provider-visible LLM context is unchanged (the error is display-only),
//   - writing the same dispatch terminalization twice is idempotent.
//
// Revert bar: without AppendDispatchError (or without the EntryDispatchError
// replay arm in flattenEntries), the child popup ends on ordinary assistant
// prose and looks successful while the agent-state row is red.
func TestAppendDispatchError_DurableDisplayOnlyHistory(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("ION_DATA_DIR", dataDir)

	const (
		conversationID = "dispatch-error-test"
		dispatchID     = "dispatch-dev-lead-1"
		errorText      = "run cancelled by engine (not recalled): child stopped before completing"
	)
	conv := CreateConversation(conversationID, "system", "model")
	AddUserMessage(conv, "do work")
	AddAssistantMessageNoUsage(conv, []types.LlmContentBlock{{Type: "text", Text: "partial progress"}})
	if err := Save(conv, ""); err != nil {
		t.Fatalf("initial Save: %v", err)
	}

	if err := AppendDispatchError(conversationID, dispatchID, errorText); err != nil {
		t.Fatalf("AppendDispatchError: %v", err)
	}
	// A terminal callback/replay may reach the persistence seam twice. The same
	// dispatch must still produce exactly one historical error row.
	if err := AppendDispatchError(conversationID, dispatchID, errorText); err != nil {
		t.Fatalf("AppendDispatchError idempotent repeat: %v", err)
	}

	loaded, err := Load(conversationID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	var entries int
	for _, entry := range loaded.Entries {
		if entry.Type != EntryDispatchError {
			continue
		}
		entries++
		data := asDispatchErrorData(entry.Data)
		if data == nil {
			t.Fatal("dispatch_error entry did not decode")
		}
		if data.DispatchID != dispatchID || data.Message != errorText {
			t.Fatalf("dispatch_error data = %+v", data)
		}
	}
	if entries != 1 {
		t.Fatalf("dispatch_error entries = %d, want 1", entries)
	}

	messages, err := LoadMessages(conversationID, "")
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}
	var errorRows int
	for _, msg := range messages {
		if msg.Role == "system" && msg.Content == "Error: "+errorText {
			errorRows++
		}
	}
	if errorRows != 1 {
		t.Fatalf("historical error rows = %d, want 1; messages=%+v", errorRows, messages)
	}

	// The durable error is for operator-visible history, never provider context.
	// Save rebuilt .llm.jsonl from BuildContextPath; it must still contain only
	// the original user + assistant turns.
	if got := BuildContextPath(loaded); len(got) != 2 {
		t.Fatalf("provider context messages = %d, want 2 (dispatch error excluded)", len(got))
	}
	llmPath := DefaultConversationsDir() + "/" + conversationID + ".llm.jsonl"
	raw, err := os.ReadFile(llmPath)
	if err != nil {
		t.Fatalf("read llm file: %v", err)
	}
	if bytes.Contains(raw, []byte(errorText)) {
		t.Fatalf("dispatch error leaked into provider-visible llm file: %s", raw)
	}
}
