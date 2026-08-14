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

func TestDispatchTranscriptRecorder_AppendsWhenNativeSessionIDIsReused(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	first := NewDispatchTranscriptRecorder("first task", "model-a")
	first.SetConversationID("reused-native")
	first.Close("first output")
	second := NewDispatchTranscriptRecorder("second task", "model-a")
	second.SetConversationID("reused-native")
	second.Close("second output")

	messages, err := LoadMessagesPaginated("reused-native", "", 0, 0)
	if err != nil {
		t.Fatalf("LoadMessagesPaginated: %v", err)
	}
	if len(messages.Messages) != 4 {
		t.Fatalf("messages = %d, want two task/output pairs", len(messages.Messages))
	}
	if messages.Messages[0].Content != "first task" || messages.Messages[3].Content != "second output" {
		t.Fatalf("history = %+v", messages.Messages)
	}
}

func TestDispatchTranscriptRecorder_DoesNotAppendEngineOwnedConversation(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	conv := CreateConversation("engine-owned-child", "", "model-a")
	AddUserMessage(conv, "engine task")
	if err := Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	recorder := NewDispatchTranscriptRecorder("mirror task", "model-a")
	recorder.SetConversationID("engine-owned-child")
	recorder.Close("mirror output")
	messages, err := LoadMessagesPaginated("engine-owned-child", "", 0, 0)
	if err != nil {
		t.Fatalf("LoadMessagesPaginated: %v", err)
	}
	if len(messages.Messages) != 1 || messages.Messages[0].Content != "engine task" {
		t.Fatalf("engine-owned history changed: %+v", messages.Messages)
	}
}
