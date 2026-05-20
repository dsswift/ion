package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// HistorySearcher is a function that searches conversation history.
// It is injected into the tool execution context by the run loop.
type HistorySearcher func(query string, maxResults int) []conversation.HistoryMatch

type historySearcherKey struct{}

// WithHistorySearcher returns a context carrying a session-scoped HistorySearcher.
func WithHistorySearcher(ctx context.Context, fn HistorySearcher) context.Context {
	return context.WithValue(ctx, historySearcherKey{}, fn)
}

// HistorySearcherFromContext extracts a session-scoped history searcher, or nil.
func HistorySearcherFromContext(ctx context.Context) HistorySearcher {
	fn, _ := ctx.Value(historySearcherKey{}).(HistorySearcher)
	return fn
}

// SearchHistoryTool returns the tool definition for SearchHistory.
func SearchHistoryTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "SearchHistory",
		Description: "Search the conversation history for specific content that may have been compacted or cleared from the active context window. Use this when you need to recall details from earlier in the conversation that are no longer visible. Returns matching snippets with context.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{
					"type":        "string",
					"description": "The search term to look for in conversation history. Case-insensitive keyword matching.",
				},
				"max_results": map[string]any{
					"type":        "number",
					"description": "Maximum number of results to return. Defaults to 20. Maximum 50.",
				},
			},
			"required": []string{"query"},
		},
		Execute: executeSearchHistory,
	}
}

func executeSearchHistory(ctx context.Context, input map[string]any, _ string) (*types.ToolResult, error) {
	query, _ := input["query"].(string)
	if query == "" {
		return &types.ToolResult{Content: "Error: query parameter is required", IsError: true}, nil
	}

	maxResults := 20
	if v, ok := input["max_results"].(float64); ok && v > 0 {
		maxResults = int(v)
	}
	if maxResults > 50 {
		maxResults = 50
	}

	searcher := HistorySearcherFromContext(ctx)
	if searcher == nil {
		return &types.ToolResult{
			Content: "SearchHistory is not available in this context (no active conversation).",
			IsError: true,
		}, nil
	}

	matches := searcher(query, maxResults)
	if len(matches) == 0 {
		return &types.ToolResult{
			Content: fmt.Sprintf("No matches found for %q in conversation history.", query),
		}, nil
	}

	// Format results as JSON for structured consumption by the model.
	formatted, err := json.MarshalIndent(struct {
		Query      string                    `json:"query"`
		MatchCount int                       `json:"matchCount"`
		Matches    []conversation.HistoryMatch `json:"matches"`
	}{
		Query:      query,
		MatchCount: len(matches),
		Matches:    matches,
	}, "", "  ")
	if err != nil {
		return &types.ToolResult{
			Content: fmt.Sprintf("Found %d matches but failed to format: %v", len(matches), err),
			IsError: true,
		}, nil
	}

	return &types.ToolResult{Content: string(formatted)}, nil
}
