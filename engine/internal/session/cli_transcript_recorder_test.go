package session

// Tests for the delegated-root structured transcript (plan §4): the recorder
// preserves text/tool order with exact inputs and results, persistCliTurn
// writes structured messages with tool_use/tool_result adjacency, and the
// text-only fallback still fires when no structured activity was recorded.

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestCliTranscriptRecorder_OrderAndExactness pins the recording contract:
// text before a tool call flushes ahead of it, the tool_use carries the
// parsed accumulated input, and the result carries the exact content and
// error flag.
func TestCliTranscriptRecorder_OrderAndExactness(t *testing.T) {
	r := newCliTranscriptRecorder()
	r.record(types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "Let me ask "}})
	r.record(types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "you something."}})
	r.record(types.NormalizedEvent{Data: &types.ToolCallEvent{ToolName: "AskUserQuestions", ToolID: "tu_1", Index: 0}})
	r.record(types.NormalizedEvent{Data: &types.ToolCallUpdateEvent{PartialInput: `{"title":`}})
	r.record(types.NormalizedEvent{Data: &types.ToolCallUpdateEvent{PartialInput: `"Scope"}`}})
	r.record(types.NormalizedEvent{Data: &types.ToolCallCompleteEvent{Index: 0}})
	r.record(types.NormalizedEvent{Data: &types.ToolResultEvent{ToolID: "tu_1", Content: `{"answers":[{"questionId":"q1","value":"yes"}]}`, IsError: false}})
	r.record(types.NormalizedEvent{Data: &types.TextChunkEvent{Text: "Thanks."}})

	items := r.drain()
	if len(items) != 4 {
		t.Fatalf("want 4 items (text, tool_use, tool_result, text), got %d: %+v", len(items), items)
	}
	if items[0].kind != "text" || items[0].text != "Let me ask you something." {
		t.Errorf("item 0: %+v", items[0])
	}
	if items[1].kind != "tool_use" || items[1].toolName != "AskUserQuestions" || items[1].toolID != "tu_1" {
		t.Errorf("item 1: %+v", items[1])
	}
	if items[1].input["title"] != "Scope" {
		t.Errorf("tool_use input not parsed from accumulated JSON: %+v", items[1].input)
	}
	if items[2].kind != "tool_result" || items[2].toolID != "tu_1" || items[2].resultIsError {
		t.Errorf("item 2: %+v", items[2])
	}
	if items[2].resultContent == "" || items[2].resultContent[0] != '{' {
		t.Errorf("tool result must carry the exact JSON verbatim: %q", items[2].resultContent)
	}
	if items[3].kind != "text" || items[3].text != "Thanks." {
		t.Errorf("item 3: %+v", items[3])
	}

	// drain resets: a second drain is empty.
	if again := r.drain(); len(again) != 0 {
		t.Errorf("drain must reset the recorder, got %+v", again)
	}
}

// TestAppendStructuredCliTurn_Adjacency pins the provider-required message
// shape: assistant blocks (text + tool_use) in one message, immediately
// followed by a user message carrying the tool_result.
func TestAppendStructuredCliTurn_Adjacency(t *testing.T) {
	conv := conversation.CreateConversation("adjacency-test", "", "m")
	items := []cliTranscriptItem{
		{kind: "text", text: "asking"},
		{kind: "tool_use", toolID: "tu_1", toolName: "AskUserQuestions", input: map[string]any{"q": 1}},
		{kind: "tool_result", toolID: "tu_1", resultContent: "answered"},
		{kind: "text", text: "done"},
	}
	if !appendStructuredCliTurn(conv, items) {
		t.Fatal("appendStructuredCliTurn wrote nothing")
	}

	msgs := conv.Messages
	if len(msgs) != 3 {
		t.Fatalf("want 3 messages (assistant, tool_result user, assistant), got %d", len(msgs))
	}
	if msgs[0].Role != "assistant" {
		t.Fatalf("msg 0 role: %s", msgs[0].Role)
	}
	blocks, _ := msgs[0].Content.([]types.LlmContentBlock) //nolint:errcheck // test fixture shape
	if len(blocks) != 2 || blocks[0].Type != "text" || blocks[1].Type != "tool_use" || blocks[1].ID != "tu_1" {
		t.Fatalf("assistant blocks: %+v", blocks)
	}
	if msgs[1].Role != "user" {
		t.Fatalf("tool_result message must be role user (provider adjacency), got %s", msgs[1].Role)
	}
	if msgs[2].Role != "assistant" {
		t.Fatalf("msg 2 role: %s", msgs[2].Role)
	}
}

// TestPersistCliTurn_StructuredAndFallback pins the persistence decision:
// with a recorder carrying tool exchanges the turn lands structured (and the
// task_complete text still completes a text-less stream); with no recorded
// activity the prior text-only behavior is unchanged.
func TestPersistCliTurn_StructuredAndFallback(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	const key, convID = "cli-structured", "1784000000005-eeeeeeeeeee1"
	_, _ = mgr.StartSession(key, defaultConfig())

	rec := newCliTranscriptRecorder()
	rec.record(types.NormalizedEvent{Data: &types.ToolCallEvent{ToolName: "AskUserQuestions", ToolID: "tu_9", Index: 0}})
	rec.record(types.NormalizedEvent{Data: &types.ToolCallCompleteEvent{Index: 0}})
	rec.record(types.NormalizedEvent{Data: &types.ToolResultEvent{ToolID: "tu_9", Content: "the answers", IsError: false}})

	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = convID
	s.pendingCliUserTurn = "please ask me"
	s.pendingCliAssistantText = "final text from task_complete"
	s.cliTranscript = rec
	mgr.mu.Unlock()

	mgr.persistCliTurn(key, convID)

	conv, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	// user turn + assistant(tool_use) + user(tool_result) + assistant(final text completion)
	if len(conv.Messages) != 4 {
		t.Fatalf("want 4 messages, got %d: %+v", len(conv.Messages), conv.Messages)
	}
	// A disk round-trip decodes Content as generic JSON ([]any of maps),
	// not typed blocks — assert on the decoded shape.
	rawBlocks, _ := conv.Messages[1].Content.([]any) //nolint:errcheck // decoded fixture shape
	if len(rawBlocks) != 1 {
		t.Fatalf("assistant message blocks: %+v", conv.Messages[1].Content)
	}
	block, _ := rawBlocks[0].(map[string]any) //nolint:errcheck // decoded fixture shape
	if block["type"] != "tool_use" || block["name"] != "AskUserQuestions" || block["id"] != "tu_9" {
		t.Fatalf("structured tool_use missing from persisted turn: %+v", block)
	}
	if conv.Messages[2].Role != "user" {
		t.Fatalf("tool_result adjacency: want user message, got %s", conv.Messages[2].Role)
	}

	// Text-only fallback: no recorder activity.
	const convID2 = "1784000000006-eeeeeeeeeee2"
	mgr.mu.Lock()
	s.conversationID = convID2
	s.pendingCliUserTurn = "plain turn"
	s.pendingCliAssistantText = "plain answer"
	s.cliTranscript = newCliTranscriptRecorder()
	mgr.mu.Unlock()
	mgr.persistCliTurn(key, convID2)

	conv2, err := conversation.Load(convID2, "")
	if err != nil {
		t.Fatalf("Load 2: %v", err)
	}
	if len(conv2.Messages) != 2 {
		t.Fatalf("text fallback: want 2 messages, got %d", len(conv2.Messages))
	}
}
