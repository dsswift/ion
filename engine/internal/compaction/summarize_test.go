package compaction

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestResolveSummaryModel_ExplicitWins(t *testing.T) {
	if got := resolveSummaryModel("custom-model"); got != "custom-model" {
		t.Errorf("explicit model: got %q, want %q", got, "custom-model")
	}
}

func TestResolveSummaryModel_EmptyNoPanic(t *testing.T) {
	// Empty string falls through to tier/default resolution.
	// We can't control modelconfig in a unit test without more setup,
	// so just verify it doesn't panic.
	_ = resolveSummaryModel("")
}

func TestFormatMessagesForSummary_Empty(t *testing.T) {
	result := FormatMessagesForSummary(nil)
	if result != "" {
		t.Errorf("expected empty string for nil messages, got %q", result)
	}
}

func TestFormatMessagesForSummary_Basic(t *testing.T) {
	msgs := []types.LlmMessage{
		{Role: "user", Content: "hello"},
		{Role: "assistant", Content: "world"},
	}
	result := FormatMessagesForSummary(msgs)

	if !strings.Contains(result, "[user]: hello") {
		t.Errorf("expected [user]: hello, got %q", result)
	}
	if !strings.Contains(result, "[assistant]: world") {
		t.Errorf("expected [assistant]: world, got %q", result)
	}
	// Messages should be separated by double newlines.
	if !strings.Contains(result, "\n\n") {
		t.Error("expected double newline separator between messages")
	}
}

func TestFormatMessagesForSummary_ContentBlocks(t *testing.T) {
	msgs := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{
			{Type: "text", Text: "block content"},
		}},
	}
	result := FormatMessagesForSummary(msgs)
	if !strings.Contains(result, "[user]: block content") {
		t.Errorf("expected block content, got %q", result)
	}
}

func TestFormatMessagesForSummary_SkipsEmptyContent(t *testing.T) {
	msgs := []types.LlmMessage{
		{Role: "user", Content: ""},
		{Role: "assistant", Content: "visible"},
	}
	result := FormatMessagesForSummary(msgs)
	if strings.Contains(result, "[user]") {
		t.Errorf("should skip empty content messages, got %q", result)
	}
	if !strings.Contains(result, "[assistant]: visible") {
		t.Errorf("expected visible message, got %q", result)
	}
}

func TestFormatMessagesForSummary_Truncation(t *testing.T) {
	longText := strings.Repeat("a", 5000)
	msgs := []types.LlmMessage{
		{Role: "user", Content: longText},
	}
	result := FormatMessagesForSummary(msgs)

	// Role prefix "[user]: " is 8 chars, truncated text is 2000, suffix is
	// "... [truncated]" (15 chars). Total should be well under 2100.
	if len(result) > 2100 {
		t.Errorf("expected truncation, got %d chars", len(result))
	}
	if !strings.Contains(result, "... [truncated]") {
		t.Error("expected truncation marker")
	}
}

func TestFormatMessagesForSummary_MultipleLongMessages(t *testing.T) {
	longText := strings.Repeat("b", 3000)
	msgs := []types.LlmMessage{
		{Role: "user", Content: longText},
		{Role: "assistant", Content: longText},
	}
	result := FormatMessagesForSummary(msgs)

	// Both messages should be truncated.
	count := strings.Count(result, "... [truncated]")
	if count != 2 {
		t.Errorf("expected 2 truncation markers, got %d", count)
	}
}

func TestSetAuthResolver(t *testing.T) {
	// Verify SetAuthResolver doesn't panic and can set/clear the resolver.
	original := authResolver
	defer func() { authResolver = original }()

	called := false
	SetAuthResolver(func(string) { called = true })
	if authResolver == nil {
		t.Fatal("expected authResolver to be set")
	}

	// Invoke to verify it works.
	authResolver("test-provider")
	if !called {
		t.Error("expected authResolver to be called")
	}

	// Clear it.
	SetAuthResolver(nil)
	if authResolver != nil {
		t.Error("expected authResolver to be nil after clearing")
	}
}

func TestDefaultSummaryMaxTokens(t *testing.T) {
	if DefaultSummaryMaxTokens != 4096 {
		t.Errorf("expected DefaultSummaryMaxTokens=4096, got %d", DefaultSummaryMaxTokens)
	}
}
