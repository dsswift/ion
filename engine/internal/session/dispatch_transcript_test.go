package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestBackfillDispatchTranscripts_UsesPersistedCompletion(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	parent := conversation.CreateConversation("parent", "", "model")
	conversation.AddUserMessageWithKind(parent,
		"[Agent worker completed]\nDispatch ID: dispatch-1\nElapsed: 5s\n\nfull historical output",
		string(types.InjectionKindAgentCompletion))
	dispatches := []conversation.AgentDispatchData{{
		AgentName: "worker", AgentID: "dispatch-1", Task: "do task", Model: "model-a", Status: "done", ConversationID: "child-native-id",
	}}

	backfillDispatchTranscripts(parent, dispatches)
	messages, err := conversation.LoadMessagesPaginated("child-native-id", "", 0, 0)
	if err != nil {
		t.Fatalf("LoadMessagesPaginated: %v", err)
	}
	if len(messages.Messages) != 2 || messages.Messages[1].Content != "full historical output" {
		t.Fatalf("backfilled history = %+v", messages.Messages)
	}
}

func TestMessageContentText_DecodedMapBlocks(t *testing.T) {
	content := []any{map[string]any{"type": "text", "text": "decoded completion"}}
	if got := messageContentText(content); got != "decoded completion" {
		t.Fatalf("messageContentText = %q", got)
	}
}

func TestBackfillDispatchTranscripts_UsesForegroundAgentToolResult(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	parent := conversation.CreateConversation("parent-tool", "", "model")
	conversation.AddAssistantMessageNoUsage(parent, []types.LlmContentBlock{{
		Type: "tool_use", ID: "agent-call", Name: "Agent", Input: map[string]any{"prompt": "inspect repository"},
	}})
	conversation.AddToolResults(parent, []conversation.ToolResultEntry{{ToolUseID: "agent-call", Content: "full tool result output"}})
	dispatches := []conversation.AgentDispatchData{{
		AgentName: "worker", AgentID: "dispatch-foreground", Task: "inspect repository", Model: "model-a", Status: "done", ConversationID: "foreground-child-id",
	}}

	backfillDispatchTranscripts(parent, dispatches)
	messages, err := conversation.LoadMessagesPaginated("foreground-child-id", "", 0, 0)
	if err != nil {
		t.Fatalf("LoadMessagesPaginated: %v", err)
	}
	if len(messages.Messages) != 2 || messages.Messages[1].Content != "full tool result output" {
		t.Fatalf("backfilled history = %+v", messages.Messages)
	}
}
