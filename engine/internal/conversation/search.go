package conversation

import (
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// HistoryMatch represents a single search result from conversation history.
type HistoryMatch struct {
	// Index is the position in the Messages slice (or Entries slice if entry-based).
	Index int `json:"index"`
	// Role of the message (user, assistant).
	Role string `json:"role"`
	// Type describes the content kind (message, tool_result, compaction).
	Type string `json:"type"`
	// Snippet is the matched content, truncated around the match point.
	Snippet string `json:"snippet"`
	// ToolName is set when the match is inside a tool_result block.
	ToolName string `json:"toolName,omitempty"`
	// ToolUseID is set when the match is inside a tool_result block.
	ToolUseID string `json:"toolUseId,omitempty"`
}

// maxSnippetLen caps the snippet length returned in each match.
const maxSnippetLen = 500

// SearchMessages performs a case-insensitive keyword search over the
// conversation's Messages slice. It returns up to maxResults matches,
// scanning from newest to oldest so the most recent hits surface first.
//
// This searches the full Messages slice including any messages that have
// already been micro-compacted (their content will be "[cleared]"), as well
// as the Entries list which preserves the original content of all messages
// including those removed by hard compaction.
func SearchMessages(conv *Conversation, query string, maxResults int) []HistoryMatch {
	if query == "" || conv == nil {
		return nil
	}
	if maxResults <= 0 {
		maxResults = 20
	}

	lowerQuery := strings.ToLower(query)
	var matches []HistoryMatch

	// Phase 1: search the in-memory Messages (may include micro-compacted entries).
	for i := len(conv.Messages) - 1; i >= 0 && len(matches) < maxResults; i-- {
		msg := conv.Messages[i]
		hits := searchMessage(msg, lowerQuery, i)
		for _, h := range hits {
			if len(matches) >= maxResults {
				break
			}
			matches = append(matches, h)
		}
	}

	// Phase 2: if we still have room, search the persisted Entries for content
	// that was dropped by hard compaction (entries preserve the original data).
	if len(matches) < maxResults && len(conv.Entries) > 0 {
		// Build a set of snippets we already found to avoid duplicates.
		seen := make(map[string]bool, len(matches))
		for _, m := range matches {
			seen[m.Snippet] = true
		}

		for i := len(conv.Entries) - 1; i >= 0 && len(matches) < maxResults; i-- {
			entry := conv.Entries[i]
			if entry.Type != EntryMessage {
				continue
			}
			md, ok := entry.Data.(MessageData)
			if !ok {
				// Handle the case where Data was deserialized as map[string]any.
				if m, ok2 := entry.Data.(map[string]any); ok2 {
					md = messageDataFromMap(m)
				} else {
					continue
				}
			}
			hits := searchMessageData(md, lowerQuery, i)
			for _, h := range hits {
				if len(matches) >= maxResults {
					break
				}
				if seen[h.Snippet] {
					continue
				}
				matches = append(matches, h)
			}
		}
	}

	return matches
}

// searchMessage extracts matches from a single LlmMessage.
func searchMessage(msg types.LlmMessage, lowerQuery string, index int) []HistoryMatch {
	var matches []HistoryMatch

	switch c := msg.Content.(type) {
	case string:
		if idx := strings.Index(strings.ToLower(c), lowerQuery); idx >= 0 {
			matches = append(matches, HistoryMatch{
				Index:   index,
				Role:    msg.Role,
				Type:    "message",
				Snippet: snippetAround(c, idx, len(lowerQuery)),
			})
		}
	case []types.LlmContentBlock:
		for _, block := range c {
			switch block.Type {
			case "text":
				if idx := strings.Index(strings.ToLower(block.Text), lowerQuery); idx >= 0 {
					matches = append(matches, HistoryMatch{
						Index:   index,
						Role:    msg.Role,
						Type:    "message",
						Snippet: snippetAround(block.Text, idx, len(lowerQuery)),
					})
				}
			case "tool_result":
				if idx := strings.Index(strings.ToLower(block.Content), lowerQuery); idx >= 0 {
					matches = append(matches, HistoryMatch{
						Index:     index,
						Role:      msg.Role,
						Type:      "tool_result",
						Snippet:   snippetAround(block.Content, idx, len(lowerQuery)),
						ToolUseID: block.ToolUseID,
					})
				}
			case "tool_use":
				// Search tool name and input for completeness.
				if idx := strings.Index(strings.ToLower(block.Name), lowerQuery); idx >= 0 {
					matches = append(matches, HistoryMatch{
						Index:    index,
						Role:     msg.Role,
						Type:     "tool_call",
						Snippet:  fmt.Sprintf("Tool call: %s", block.Name),
						ToolName: block.Name,
					})
				}
			}
		}
	}
	return matches
}

// searchMessageData extracts matches from a MessageData (entry-based).
func searchMessageData(md MessageData, lowerQuery string, index int) []HistoryMatch {
	var matches []HistoryMatch

	switch c := md.Content.(type) {
	case string:
		if idx := strings.Index(strings.ToLower(c), lowerQuery); idx >= 0 {
			matches = append(matches, HistoryMatch{
				Index:   index,
				Role:    md.Role,
				Type:    "message",
				Snippet: snippetAround(c, idx, len(lowerQuery)),
			})
		}
	case []types.LlmContentBlock:
		for _, block := range c {
			switch block.Type {
			case "text":
				if idx := strings.Index(strings.ToLower(block.Text), lowerQuery); idx >= 0 {
					matches = append(matches, HistoryMatch{
						Index:   index,
						Role:    md.Role,
						Type:    "message",
						Snippet: snippetAround(block.Text, idx, len(lowerQuery)),
					})
				}
			case "tool_result":
				if idx := strings.Index(strings.ToLower(block.Content), lowerQuery); idx >= 0 {
					matches = append(matches, HistoryMatch{
						Index:     index,
						Role:      md.Role,
						Type:      "tool_result",
						Snippet:   snippetAround(block.Content, idx, len(lowerQuery)),
						ToolUseID: block.ToolUseID,
					})
				}
			}
		}
	}
	return matches
}

// messageDataFromMap extracts a MessageData from a generic map (handles
// JSON-deserialized entry data).
func messageDataFromMap(m map[string]any) MessageData {
	md := MessageData{}
	if r, ok := m["role"].(string); ok {
		md.Role = r
	}
	md.Content = m["content"]
	return md
}

// snippetAround extracts a snippet of up to maxSnippetLen characters
// centered on the match at position idx with length matchLen.
func snippetAround(text string, idx, matchLen int) string {
	if len(text) <= maxSnippetLen {
		return text
	}

	// Center the window on the match.
	half := (maxSnippetLen - matchLen) / 2
	start := idx - half
	if start < 0 {
		start = 0
	}
	end := start + maxSnippetLen
	if end > len(text) {
		end = len(text)
		start = end - maxSnippetLen
		if start < 0 {
			start = 0
		}
	}

	snippet := text[start:end]
	if start > 0 {
		snippet = "..." + snippet
	}
	if end < len(text) {
		snippet = snippet + "..."
	}
	return snippet
}
