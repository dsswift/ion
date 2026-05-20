package conversation

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestSearchMessages_EmptyQuery(t *testing.T) {
	conv := CreateConversation("test", "", "model")
	AddUserMessage(conv, "hello world")
	matches := SearchMessages(conv, "", 10)
	if len(matches) != 0 {
		t.Errorf("expected 0 matches for empty query, got %d", len(matches))
	}
}

func TestSearchMessages_NilConversation(t *testing.T) {
	matches := SearchMessages(nil, "hello", 10)
	if len(matches) != 0 {
		t.Errorf("expected 0 matches for nil conversation, got %d", len(matches))
	}
}

func TestSearchMessages_TextMessage(t *testing.T) {
	conv := CreateConversation("test", "", "model")
	AddUserMessage(conv, "The quick brown fox jumps over the lazy dog")
	AddAssistantMessage(conv, []types.LlmContentBlock{
		{Type: "text", Text: "I see a fox in your message"},
	}, types.LlmUsage{})

	matches := SearchMessages(conv, "fox", 10)
	if len(matches) != 2 {
		t.Fatalf("expected 2 matches, got %d", len(matches))
	}
	// Newest first: assistant message (index 1) before user message (index 0).
	if matches[0].Role != "assistant" {
		t.Errorf("expected first match role=assistant, got %s", matches[0].Role)
	}
	if matches[1].Role != "user" {
		t.Errorf("expected second match role=user, got %s", matches[1].Role)
	}
}

func TestSearchMessages_CaseInsensitive(t *testing.T) {
	conv := CreateConversation("test", "", "model")
	AddUserMessage(conv, "Hello World")

	matches := SearchMessages(conv, "hello world", 10)
	if len(matches) != 1 {
		t.Fatalf("expected 1 match for case-insensitive search, got %d", len(matches))
	}
}

func TestSearchMessages_ToolResult(t *testing.T) {
	conv := CreateConversation("test", "", "model")
	AddToolResults(conv, []ToolResultEntry{
		{ToolUseID: "tool-1", Content: "file contents: important data here", IsError: false},
		{ToolUseID: "tool-2", Content: "no match in this one", IsError: false},
	})

	matches := SearchMessages(conv, "important data", 10)
	if len(matches) != 1 {
		t.Fatalf("expected 1 match, got %d", len(matches))
	}
	if matches[0].Type != "tool_result" {
		t.Errorf("expected type=tool_result, got %s", matches[0].Type)
	}
	if matches[0].ToolUseID != "tool-1" {
		t.Errorf("expected toolUseID=tool-1, got %s", matches[0].ToolUseID)
	}
}

func TestSearchMessages_MaxResults(t *testing.T) {
	conv := CreateConversation("test", "", "model")
	for i := 0; i < 30; i++ {
		AddUserMessage(conv, "needle in a haystack")
	}

	matches := SearchMessages(conv, "needle", 5)
	if len(matches) != 5 {
		t.Errorf("expected 5 matches (maxResults cap), got %d", len(matches))
	}
}

func TestSearchMessages_NoMatch(t *testing.T) {
	conv := CreateConversation("test", "", "model")
	AddUserMessage(conv, "hello world")

	matches := SearchMessages(conv, "nonexistent", 10)
	if len(matches) != 0 {
		t.Errorf("expected 0 matches, got %d", len(matches))
	}
}

func TestSearchMessages_SnippetTruncation(t *testing.T) {
	conv := CreateConversation("test", "", "model")
	// Create a very long message
	longText := strings.Repeat("a", 300) + "FINDME" + strings.Repeat("b", 300)
	AddUserMessage(conv, longText)

	matches := SearchMessages(conv, "FINDME", 10)
	if len(matches) != 1 {
		t.Fatalf("expected 1 match, got %d", len(matches))
	}
	// Snippet should be capped around maxSnippetLen
	if len(matches[0].Snippet) > maxSnippetLen+10 { // +10 for "..." prefix/suffix
		t.Errorf("snippet too long: %d chars", len(matches[0].Snippet))
	}
	if !strings.Contains(matches[0].Snippet, "FINDME") {
		t.Error("snippet should contain the search term")
	}
}

func TestSearchMessages_EntriesAfterCompaction(t *testing.T) {
	conv := CreateConversation("test", "", "model")
	// Add messages that will be preserved in Entries
	AddUserMessage(conv, "important secret: alpha-beta-gamma")
	AddAssistantMessage(conv, []types.LlmContentBlock{
		{Type: "text", Text: "I noted the secret"},
	}, types.LlmUsage{})

	// Add more messages to push the old ones out
	for i := 0; i < 5; i++ {
		AddUserMessage(conv, "padding message")
		AddAssistantMessage(conv, []types.LlmContentBlock{
			{Type: "text", Text: "padding response"},
		}, types.LlmUsage{})
	}

	// Hard-compact, keeping only 2 turns
	Compact(conv, 2)

	// The "alpha-beta-gamma" message should be gone from Messages...
	foundInMessages := false
	for _, msg := range conv.Messages {
		text := extractText(msg)
		if strings.Contains(text, "alpha-beta-gamma") {
			foundInMessages = true
		}
	}
	if foundInMessages {
		t.Error("expected compacted message to be absent from Messages")
	}

	// ...but SearchMessages should find it in Entries
	matches := SearchMessages(conv, "alpha-beta-gamma", 10)
	if len(matches) == 0 {
		t.Error("expected to find compacted content via Entries search")
	}
}

func TestSearchMessages_DefaultMaxResults(t *testing.T) {
	conv := CreateConversation("test", "", "model")
	for i := 0; i < 25; i++ {
		AddUserMessage(conv, "repeated keyword")
	}

	// Pass 0 for maxResults; should default to 20.
	matches := SearchMessages(conv, "keyword", 0)
	if len(matches) != 20 {
		t.Errorf("expected 20 (default max), got %d", len(matches))
	}
}

func TestSnippetAround(t *testing.T) {
	tests := []struct {
		name     string
		text     string
		idx      int
		matchLen int
		wantContains string
	}{
		{
			name:         "short text",
			text:         "hello world",
			idx:          6,
			matchLen:     5,
			wantContains: "world",
		},
		{
			name:         "match at start of long text",
			text:         "FINDME" + strings.Repeat("x", 600),
			idx:          0,
			matchLen:     6,
			wantContains: "FINDME",
		},
		{
			name:         "match at end of long text",
			text:         strings.Repeat("x", 600) + "FINDME",
			idx:          600,
			matchLen:     6,
			wantContains: "FINDME",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			snippet := snippetAround(tt.text, tt.idx, tt.matchLen)
			if !strings.Contains(snippet, tt.wantContains) {
				t.Errorf("snippet does not contain %q: %s", tt.wantContains, snippet)
			}
			if len(tt.text) > maxSnippetLen && len(snippet) > maxSnippetLen+10 {
				t.Errorf("snippet too long: %d", len(snippet))
			}
		})
	}
}
