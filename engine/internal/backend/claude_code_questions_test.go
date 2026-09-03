package backend

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestCanonicalQuestionToolName pins the alias mapping: both question tools, in
// both their bare and MCP-prefixed forms, collapse to the bare canonical name
// the session and desktop consumers match on; everything else is not a question.
func TestCanonicalQuestionToolName(t *testing.T) {
	cases := map[string]string{
		tools.AskUserQuestionName:   tools.AskUserQuestionName,
		tools.AskUserQuestionsName:  tools.AskUserQuestionsName,
		mcpAskUserQuestionToolName:  tools.AskUserQuestionName,
		mcpAskUserQuestionsToolName: tools.AskUserQuestionsName,
		"ExitPlanMode":              "",
		"Read":                      "",
		"":                          "",
	}
	for in, want := range cases {
		if got := canonicalQuestionToolName(in); got != want {
			t.Errorf("canonicalQuestionToolName(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestHandleQuestionAssistant_CapturesBothToolsAllAliases pins that a streamed
// question tool_use — singular or plural, bare or MCP-prefixed — is captured as
// a retained PermissionDenial carrying the bare canonical name, the tool_use ID,
// and the full input. This is the claude-code half of "questions behave the same
// on every backend". Reverting the MCP-prefix mapping or the capture turns it
// red: the MCP-prefixed call is exactly how the claude-code model invokes it.
func TestHandleQuestionAssistant_CapturesBothToolsAllAliases(t *testing.T) {
	b := NewClaudeCodeBackend()
	run := &claudeCodeRun{requestID: "r1"}

	ev := &types.TaskUpdateEvent{Message: types.AssistantMessagePayload{Content: []types.ContentBlock{
		{Type: "text", Text: "context for the user"},
		{Type: "tool_use", ID: "tu-single", Name: mcpAskUserQuestionToolName, Input: map[string]any{"question": "Which one?"}},
		{Type: "tool_use", ID: "tu-multi", Name: tools.AskUserQuestionsName, Input: map[string]any{"questions": []any{"a", "b"}}},
		{Type: "tool_use", ID: "tu-other", Name: "Read", Input: map[string]any{"file_path": "/x"}},
	}}}

	b.handleQuestionAssistant(run, ev)

	if len(run.pendingQuestionDenials) != 2 {
		t.Fatalf("want 2 captured question denials, got %d", len(run.pendingQuestionDenials))
	}

	single := run.pendingQuestionDenials[0]
	if single.ToolName != tools.AskUserQuestionName {
		t.Errorf("single denial name = %q, want %q (bare canonical, not the MCP alias)", single.ToolName, tools.AskUserQuestionName)
	}
	if single.ToolUseID != "tu-single" {
		t.Errorf("single denial tool_use id = %q, want tu-single", single.ToolUseID)
	}
	if single.ToolInput["question"] != "Which one?" {
		t.Errorf("single denial lost its input: %v", single.ToolInput)
	}

	multi := run.pendingQuestionDenials[1]
	if multi.ToolName != tools.AskUserQuestionsName {
		t.Errorf("multi denial name = %q, want %q", multi.ToolName, tools.AskUserQuestionsName)
	}
	if multi.ToolUseID != "tu-multi" {
		t.Errorf("multi denial tool_use id = %q, want tu-multi", multi.ToolUseID)
	}
}

// TestInjectQuestionDenials_AppendsOntoResult pins that captured question
// denials are injected onto the CLI's result event. The claude-code MCP handler
// auto-acknowledges the call, so the CLI reports no permission_denial of its
// own — injection is the ONLY path a question reaches the session. Reverting the
// injection leaves the result denial-free and the question silently lost.
func TestInjectQuestionDenials_AppendsOntoResult(t *testing.T) {
	b := NewClaudeCodeBackend()
	run := &claudeCodeRun{requestID: "r1", pendingQuestionDenials: []types.PermissionDenial{
		{ToolName: tools.AskUserQuestionsName, ToolUseID: "tu-1", ToolInput: map[string]any{"questions": []any{"a"}}},
	}}
	e := &types.TaskCompleteEvent{}
	b.injectQuestionDenials(run, e)

	if len(e.PermissionDenials) != 1 {
		t.Fatalf("want 1 injected denial, got %d", len(e.PermissionDenials))
	}
	if e.PermissionDenials[0].ToolName != tools.AskUserQuestionsName {
		t.Errorf("injected denial name = %q, want %q", e.PermissionDenials[0].ToolName, tools.AskUserQuestionsName)
	}
	if e.PermissionDenials[0].ToolUseID != "tu-1" {
		t.Errorf("injected denial tool_use id = %q, want tu-1", e.PermissionDenials[0].ToolUseID)
	}
}

// TestInjectQuestionDenials_NoQuestionNoDenial guards the common path: a run
// that asked nothing must not fabricate a denial onto its result.
func TestInjectQuestionDenials_NoQuestionNoDenial(t *testing.T) {
	b := NewClaudeCodeBackend()
	run := &claudeCodeRun{requestID: "r1"}
	e := &types.TaskCompleteEvent{}
	b.injectQuestionDenials(run, e)
	if len(e.PermissionDenials) != 0 {
		t.Fatalf("want 0 denials on a run with no question, got %d", len(e.PermissionDenials))
	}
}
