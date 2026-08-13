package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestMaterializeDispatchTranscript_CreatesLoadableHistory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	const id = "native-child-session"
	if err := MaterializeDispatchTranscript(id, "inspect code", "finished work", "model-a"); err != nil {
		t.Fatalf("MaterializeDispatchTranscript: %v", err)
	}
	messages, err := LoadMessagesPaginated(id, "", 0, 0)
	if err != nil {
		t.Fatalf("LoadMessagesPaginated: %v", err)
	}
	if len(messages.Messages) != 2 {
		t.Fatalf("messages = %d, want user + assistant", len(messages.Messages))
	}
	if messages.Messages[0].Content != "inspect code" || messages.Messages[1].Content != "finished work" {
		t.Fatalf("history = %+v", messages.Messages)
	}
}

func TestDispatchTranscriptRecorder_PersistsTextAndTools(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	recorder := NewDispatchTranscriptRecorder("inspect code", "model-a")
	recorder.SetConversationID("native-child-stream")
	recorder.Record(types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "before tool"}})
	recorder.Record(types.NormalizedEvent{Data: &types.ToolCallEvent{ToolName: "Read", ToolID: "tool-1"}})
	recorder.Record(types.NormalizedEvent{Data: &types.ToolResultEvent{ToolID: "tool-1", Content: "file body"}})
	recorder.Record(types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "after tool"}})
	recorder.Close("fallback")

	messages, err := LoadMessagesPaginated("native-child-stream", "", 0, 0)
	if err != nil {
		t.Fatalf("LoadMessagesPaginated: %v", err)
	}
	if len(messages.Messages) != 4 {
		t.Fatalf("messages = %d, want task + text + tool + text; %+v", len(messages.Messages), messages.Messages)
	}
	if messages.Messages[1].Content != "before tool" || messages.Messages[2].Role != "tool" || messages.Messages[2].Content != "file body" || messages.Messages[3].Content != "after tool" {
		t.Fatalf("history = %+v", messages.Messages)
	}
}
