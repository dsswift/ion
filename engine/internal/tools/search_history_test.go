package tools

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
)

func TestSearchHistoryTool_NoSearcher(t *testing.T) {
	tool := SearchHistoryTool()
	result, err := tool.Execute(context.Background(), map[string]any{
		"query": "test",
	}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Error("expected error result when no searcher is in context")
	}
}

func TestSearchHistoryTool_EmptyQuery(t *testing.T) {
	ctx := WithHistorySearcher(context.Background(), func(query string, maxResults int) []conversation.HistoryMatch {
		return nil
	})
	tool := SearchHistoryTool()
	result, err := tool.Execute(ctx, map[string]any{}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Error("expected error result for empty query")
	}
}

func TestSearchHistoryTool_NoMatches(t *testing.T) {
	ctx := WithHistorySearcher(context.Background(), func(query string, maxResults int) []conversation.HistoryMatch {
		return nil
	})
	tool := SearchHistoryTool()
	result, err := tool.Execute(ctx, map[string]any{
		"query": "nonexistent",
	}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.IsError {
		t.Error("no-match result should not be an error")
	}
	if result.Content == "" {
		t.Error("expected non-empty content for no-match")
	}
}

func TestSearchHistoryTool_WithMatches(t *testing.T) {
	ctx := WithHistorySearcher(context.Background(), func(query string, maxResults int) []conversation.HistoryMatch {
		return []conversation.HistoryMatch{
			{Index: 5, Role: "user", Type: "message", Snippet: "found the needle"},
			{Index: 3, Role: "assistant", Type: "tool_result", Snippet: "needle in tool output", ToolUseID: "t1"},
		}
	})
	tool := SearchHistoryTool()
	result, err := tool.Execute(ctx, map[string]any{
		"query":       "needle",
		"max_results": float64(10),
	}, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.IsError {
		t.Errorf("expected success, got error: %s", result.Content)
	}
	if result.Content == "" {
		t.Error("expected non-empty content")
	}
}

func TestSearchHistoryTool_MaxResultsCapped(t *testing.T) {
	var capturedMax int
	ctx := WithHistorySearcher(context.Background(), func(query string, maxResults int) []conversation.HistoryMatch {
		capturedMax = maxResults
		return nil
	})
	tool := SearchHistoryTool()
	_, _ = tool.Execute(ctx, map[string]any{
		"query":       "test",
		"max_results": float64(100),
	}, "")
	if capturedMax != 50 {
		t.Errorf("expected max_results capped at 50, got %d", capturedMax)
	}
}

func TestHistorySearcherContext(t *testing.T) {
	t.Run("nil when not set", func(t *testing.T) {
		fn := HistorySearcherFromContext(context.Background())
		if fn != nil {
			t.Error("expected nil searcher from empty context")
		}
	})

	t.Run("round-trips through context", func(t *testing.T) {
		called := false
		searcher := func(query string, maxResults int) []conversation.HistoryMatch {
			called = true
			return nil
		}
		ctx := WithHistorySearcher(context.Background(), searcher)
		fn := HistorySearcherFromContext(ctx)
		if fn == nil {
			t.Fatal("expected non-nil searcher")
		}
		fn("test", 10)
		if !called {
			t.Error("expected searcher to be called")
		}
	})
}
