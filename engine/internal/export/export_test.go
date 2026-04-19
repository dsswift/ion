package export

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

func makeConv() *conversation.Conversation {
	conv := conversation.CreateConversation("test-123", "You are helpful.", "claude-3-opus")
	conversation.AddUserMessage(conv, "Hello, how are you?")
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{
		{Type: "text", Text: "I'm doing well, thanks for asking!"},
	}, types.LlmUsage{InputTokens: 10, OutputTokens: 20})
	return conv
}

func TestExportJSON(t *testing.T) {
	conv := makeConv()
	result, err := ExportSession(conv, Options{Format: "json"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "test-123") {
		t.Error("expected session ID in JSON output")
	}
	if !strings.Contains(result, "claude-3-opus") {
		t.Error("expected model in JSON output")
	}
}

func TestExportMarkdown(t *testing.T) {
	conv := makeConv()
	result, err := ExportSession(conv, Options{Format: "markdown"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "# Session: test-123") {
		t.Error("expected markdown header")
	}
	if !strings.Contains(result, "### User") {
		t.Error("expected User heading")
	}
	if !strings.Contains(result, "### Assistant") {
		t.Error("expected Assistant heading")
	}
	if !strings.Contains(result, "doing well") {
		t.Error("expected message content")
	}
}

func TestExportHTML(t *testing.T) {
	conv := makeConv()
	result, err := ExportSession(conv, Options{Format: "html"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "<!DOCTYPE html>") {
		t.Error("expected HTML doctype")
	}
	if !strings.Contains(result, "test-123") {
		t.Error("expected session ID in HTML")
	}
	if !strings.Contains(result, "<style>") {
		t.Error("expected embedded CSS")
	}
	if !strings.Contains(result, "doing well") {
		t.Error("expected message content in HTML")
	}
}

func TestExportHTMLToolResults(t *testing.T) {
	conv := conversation.CreateConversation("tool-test", "system", "model")
	conversation.AddUserMessage(conv, "run a command")
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{
		{Type: "text", Text: "Running the command now."},
	}, types.LlmUsage{InputTokens: 5, OutputTokens: 10})
	conversation.AddToolResults(conv, []conversation.ToolResultEntry{
		{ToolUseID: "tool1", Content: "output from tool"},
	})

	result, err := ExportSession(conv, Options{Format: "html"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "<details>") {
		t.Error("expected collapsible details for tool result")
	}
	if !strings.Contains(result, "output from tool") {
		t.Error("expected tool output in HTML")
	}
}

func TestExportRedactSecrets(t *testing.T) {
	conv := conversation.CreateConversation("redact-test", "system", "model")
	conversation.AddUserMessage(conv, "My token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn okay?")

	result, err := ExportSession(conv, Options{Format: "markdown", RedactSecrets: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(result, "ghp_") {
		t.Error("expected GitHub token to be redacted")
	}
	if !strings.Contains(result, "[REDACTED:") {
		t.Error("expected redaction marker")
	}
}

func TestExportUnsupportedFormat(t *testing.T) {
	conv := makeConv()
	_, err := ExportSession(conv, Options{Format: "xml"})
	if err == nil {
		t.Error("expected error for unsupported format")
	}
}

func TestExportNilConversation(t *testing.T) {
	_, err := ExportSession(nil, Options{Format: "json"})
	if err == nil {
		t.Error("expected error for nil conversation")
	}
}

// --- New tests ported from TS ---

func strPtr(s string) *string {
	return &s
}

func makeTreeConv() *conversation.Conversation {
	// Build a conversation with a tree structure:
	// root(e1) -> e2 -> e3 (linear path, active branch)
	//                 -> e4 (branch off e2)
	conv := conversation.CreateConversation("tree-test", "system", "model")
	conv.Entries = []conversation.SessionEntry{
		{ID: "e1", ParentID: nil, Type: conversation.EntryMessage, Timestamp: 1000,
			Data: conversation.MessageData{Role: "user", Content: "hello"}},
		{ID: "e2", ParentID: strPtr("e1"), Type: conversation.EntryMessage, Timestamp: 2000,
			Data: conversation.MessageData{Role: "assistant", Content: "hi there"}},
		{ID: "e3", ParentID: strPtr("e2"), Type: conversation.EntryMessage, Timestamp: 3000,
			Data: conversation.MessageData{Role: "user", Content: "tell me more"}},
		{ID: "e4", ParentID: strPtr("e2"), Type: conversation.EntryMessage, Timestamp: 3500,
			Data: conversation.MessageData{Role: "user", Content: "branch message"}},
	}
	conv.LeafID = strPtr("e3")
	return conv
}

func TestExportJSONL_FullTree(t *testing.T) {
	conv := makeTreeConv()
	result, err := ExportSession(conv, Options{Format: "jsonl", FullTree: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(result), "\n")
	// Full tree should include all 4 entries.
	if len(lines) != 4 {
		t.Errorf("expected 4 JSONL lines for full tree, got %d", len(lines))
	}

	// Verify each line is valid JSON.
	for i, line := range lines {
		var raw map[string]any
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			t.Errorf("line %d is not valid JSON: %v", i, err)
		}
	}
}

func TestExportJSONL_ActiveBranchOnly(t *testing.T) {
	conv := makeTreeConv()
	result, err := ExportSession(conv, Options{Format: "jsonl", FullTree: false})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(result), "\n")
	// Active branch (e1 -> e2 -> e3) = 3 entries, excluding e4.
	if len(lines) != 3 {
		t.Errorf("expected 3 JSONL lines for active branch, got %d", len(lines))
	}

	// Should not contain the branch message.
	if strings.Contains(result, "branch message") {
		t.Error("active branch should not include e4 branch message")
	}
}

func TestExportJSONL_WithRedaction(t *testing.T) {
	conv := conversation.CreateConversation("redact-jsonl", "system", "model")
	conv.Entries = []conversation.SessionEntry{
		{ID: "r1", ParentID: nil, Type: conversation.EntryMessage, Timestamp: 1000,
			Data: conversation.MessageData{Role: "user", Content: "my token is ghp_ABCDEF123456 and sk-ant-xyz789"}},
	}
	conv.LeafID = strPtr("r1")

	result, err := ExportSession(conv, Options{Format: "jsonl", FullTree: true, RedactSecrets: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if strings.Contains(result, "ghp_ABCDEF123456") {
		t.Error("expected GitHub token to be redacted")
	}
	if strings.Contains(result, "sk-ant-xyz789") {
		t.Error("expected Anthropic key to be redacted")
	}
	if !strings.Contains(result, "[REDACTED:github_token]") {
		t.Error("expected GitHub redaction marker")
	}
	if !strings.Contains(result, "[REDACTED:anthropic_key]") {
		t.Error("expected Anthropic redaction marker")
	}
}

func TestFilterActiveBranch_Linear(t *testing.T) {
	entries := []conversation.SessionEntry{
		{ID: "a", ParentID: nil},
		{ID: "b", ParentID: strPtr("a")},
		{ID: "c", ParentID: strPtr("b")},
	}

	result := filterActiveBranch(entries, "c")
	if len(result) != 3 {
		t.Errorf("expected 3 entries on linear path, got %d", len(result))
	}
}

func TestFilterActiveBranch_BranchedTree(t *testing.T) {
	entries := []conversation.SessionEntry{
		{ID: "a", ParentID: nil},
		{ID: "b", ParentID: strPtr("a")},
		{ID: "c", ParentID: strPtr("b")},  // branch 1
		{ID: "d", ParentID: strPtr("b")},  // branch 2
	}

	// Active branch from "c" should be a -> b -> c (3 entries).
	result := filterActiveBranch(entries, "c")
	if len(result) != 3 {
		t.Errorf("expected 3 entries for branch to c, got %d", len(result))
	}
	for _, e := range result {
		if e.ID == "d" {
			t.Error("should not include entry d in branch to c")
		}
	}

	// Active branch from "d" should be a -> b -> d (3 entries).
	result2 := filterActiveBranch(entries, "d")
	if len(result2) != 3 {
		t.Errorf("expected 3 entries for branch to d, got %d", len(result2))
	}
	for _, e := range result2 {
		if e.ID == "c" {
			t.Error("should not include entry c in branch to d")
		}
	}
}

func TestRedactEntry_MessageType(t *testing.T) {
	entry := conversation.SessionEntry{
		ID:   "r1",
		Type: conversation.EntryMessage,
		Data: conversation.MessageData{
			Role:    "user",
			Content: "token: sk_live_abc123xyz",
		},
	}

	redacted := redactEntry(entry)
	b, _ := json.Marshal(redacted.Data)
	s := string(b)

	if strings.Contains(s, "sk_live_abc123xyz") {
		t.Error("expected stripe key to be redacted")
	}
	if !strings.Contains(s, "[REDACTED:stripe_key]") {
		t.Error("expected stripe redaction marker")
	}
}

func TestRedactEntry_NonMessageType(t *testing.T) {
	entry := conversation.SessionEntry{
		ID:   "c1",
		Type: conversation.EntryCompaction,
		Data: conversation.CompactionData{
			Summary: "summary with ghp_secret123",
		},
	}

	// Non-message types should pass through unmodified.
	redacted := redactEntry(entry)
	b, _ := json.Marshal(redacted.Data)
	if !strings.Contains(string(b), "ghp_secret123") {
		t.Error("non-message entry should not be redacted")
	}
}

func TestRedactSecretPatterns_AllTypes(t *testing.T) {
	tests := []struct {
		input    string
		contains string
	}{
		{"token ghp_abc123", "[REDACTED:github_token]"},
		{"token gho_abc123", "[REDACTED:github_token]"},
		{"key sk_live_abc123", "[REDACTED:stripe_key]"},
		{"key sk_test_abc123", "[REDACTED:stripe_key]"},
		{"key sk-ant-abc123", "[REDACTED:anthropic_key]"},
		{"token xoxb-abc123", "[REDACTED:slack_token]"},
		{"token xoxp-abc123", "[REDACTED:slack_token]"},
		{"key AKIAIOSFODNN7EXAMPLE", "[REDACTED:aws_key]"},
	}

	for _, tt := range tests {
		result := redactSecretPatterns(tt.input)
		if !strings.Contains(result, tt.contains) {
			t.Errorf("input %q: expected %q in result %q", tt.input, tt.contains, result)
		}
	}
}
