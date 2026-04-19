// Package compaction extracts facts from conversation messages and supports
// partial compaction with fact-based summaries.
package compaction

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// Fact is a structured piece of information extracted from conversation messages.
type Fact struct {
	Type    string // "decision", "file_mod", "error", "preference", "discovery"
	Content string
	Source  int // message index
}

// Pattern sets for fact extraction.
var (
	decisionPatterns   = regexp.MustCompile(`(?i)\b(?:decided to|chose|will use|going with|selected|opted for)\b`)
	fileModPatterns    = regexp.MustCompile(`(?:^|\s)(?:/[\w./-]+|\.{1,2}/[\w./-]+)`)
	errorPatterns      = regexp.MustCompile(`(?i)\b(?:error|failed|failure|bug|exception|crash|broken|issue)\b`)
	preferencePatterns = regexp.MustCompile(`(?i)\b(?:prefer|always|never|should always|should never|don't|do not)\b`)
	discoveryPatterns  = regexp.MustCompile(`(?i)\b(?:found|discovered|noticed|realized|learned|turns out)\b`)
)

// ExtractFacts scans messages for patterns and returns structured facts.
func ExtractFacts(messages []types.LlmMessage) []Fact {
	var facts []Fact

	for i, msg := range messages {
		text := extractText(msg)
		if text == "" {
			continue
		}

		// Check for file paths in tool results.
		if hasToolResults(msg) {
			paths := fileModPatterns.FindAllString(text, -1)
			for _, p := range paths {
				p = strings.TrimSpace(p)
				if p != "" && (strings.HasPrefix(p, "/") || strings.HasPrefix(p, "./") || strings.HasPrefix(p, "../")) {
					facts = append(facts, Fact{Type: "file_mod", Content: p, Source: i})
				}
			}
		}

		if decisionPatterns.MatchString(text) {
			sentence := extractMatchingSentence(text, decisionPatterns)
			if sentence != "" {
				facts = append(facts, Fact{Type: "decision", Content: sentence, Source: i})
			}
		}

		if errorPatterns.MatchString(text) {
			sentence := extractMatchingSentence(text, errorPatterns)
			if sentence != "" {
				facts = append(facts, Fact{Type: "error", Content: sentence, Source: i})
			}
		}

		if preferencePatterns.MatchString(text) {
			sentence := extractMatchingSentence(text, preferencePatterns)
			if sentence != "" {
				facts = append(facts, Fact{Type: "preference", Content: sentence, Source: i})
			}
		}

		if discoveryPatterns.MatchString(text) {
			sentence := extractMatchingSentence(text, discoveryPatterns)
			if sentence != "" {
				facts = append(facts, Fact{Type: "discovery", Content: sentence, Source: i})
			}
		}
	}

	return facts
}

// FormatFactsSummary formats extracted facts into a human-readable summary grouped by type.
func FormatFactsSummary(facts []Fact) string {
	grouped := make(map[string][]Fact)
	order := []string{"decision", "file_mod", "error", "preference", "discovery"}

	for _, f := range facts {
		grouped[f.Type] = append(grouped[f.Type], f)
	}

	var sb strings.Builder
	labels := map[string]string{
		"decision":   "Decisions",
		"file_mod":   "Files Modified",
		"error":      "Errors Encountered",
		"preference": "Preferences",
		"discovery":  "Discoveries",
	}

	for _, typ := range order {
		items := grouped[typ]
		if len(items) == 0 {
			continue
		}
		label := labels[typ]
		if label == "" {
			label = typ
		}
		fmt.Fprintf(&sb, "## %s\n", label)
		for _, f := range items {
			fmt.Fprintf(&sb, "- %s\n", f.Content)
		}
		sb.WriteString("\n")
	}

	return strings.TrimSpace(sb.String())
}

// CompactPartial removes entries from a conversation tree, keeping everything
// after pivotEntryID. Direction is "before" (remove older) or "after" (remove newer).
func CompactPartial(conv *conversation.Conversation, pivotEntryID string, direction string) error {
	if len(conv.Entries) == 0 {
		return nil
	}

	pivotIdx := -1
	for i, e := range conv.Entries {
		if e.ID == pivotEntryID {
			pivotIdx = i
			break
		}
	}
	if pivotIdx < 0 {
		return fmt.Errorf("pivot entry not found: %s", pivotEntryID)
	}

	switch direction {
	case "before":
		// Keep entries from pivot onward.
		conv.Entries = conv.Entries[pivotIdx:]
	case "after":
		// Keep entries up to and including pivot.
		conv.Entries = conv.Entries[:pivotIdx+1]
		conv.LeafID = &conv.Entries[len(conv.Entries)-1].ID
	default:
		return fmt.Errorf("invalid direction: %s (expected 'before' or 'after')", direction)
	}

	conv.Messages = conversation.BuildContextPath(conv)
	return nil
}

// PostCompactRestore creates a system message summarizing what was preserved
// after compaction, including recent file paths and deferred tool mentions.
func PostCompactRestore(conv *conversation.Conversation, recentFiles []string, deferredTools []string) types.LlmMessage {
	var parts []string

	if len(recentFiles) > 0 {
		parts = append(parts, "Recently modified files: "+strings.Join(recentFiles, ", "))
	}
	if len(deferredTools) > 0 {
		parts = append(parts, "Deferred tool calls: "+strings.Join(deferredTools, ", "))
	}

	text := "[Post-compaction context restore]"
	if len(parts) > 0 {
		text += "\n" + strings.Join(parts, "\n")
	}

	return types.LlmMessage{
		Role: "user",
		Content: []types.LlmContentBlock{{
			Type: "text",
			Text: text,
		}},
	}
}

// ExtractRecentFiles scans messages for file paths mentioned in tool results.
func ExtractRecentFiles(messages []types.LlmMessage) []string {
	seen := make(map[string]bool)
	var files []string

	for _, msg := range messages {
		if !hasToolResults(msg) {
			continue
		}
		text := extractText(msg)
		paths := fileModPatterns.FindAllString(text, -1)
		for _, p := range paths {
			p = strings.TrimSpace(p)
			if p != "" && !seen[p] && (strings.HasPrefix(p, "/") || strings.HasPrefix(p, "./") || strings.HasPrefix(p, "../")) {
				seen[p] = true
				files = append(files, p)
			}
		}
	}

	return files
}

// --- internal helpers ---

func extractText(msg types.LlmMessage) string {
	switch c := msg.Content.(type) {
	case string:
		return c
	case []types.LlmContentBlock:
		var parts []string
		for _, b := range c {
			if b.Type == "text" && b.Text != "" {
				parts = append(parts, b.Text)
			}
			if b.Type == "tool_result" && b.Content != "" {
				parts = append(parts, b.Content)
			}
		}
		return strings.Join(parts, "\n")
	case []any:
		var parts []string
		for _, item := range c {
			if m, ok := item.(map[string]any); ok {
				if t, _ := m["type"].(string); t == "text" {
					if text, ok := m["text"].(string); ok {
						parts = append(parts, text)
					}
				}
				if t, _ := m["type"].(string); t == "tool_result" {
					if text, ok := m["content"].(string); ok {
						parts = append(parts, text)
					}
				}
			}
		}
		return strings.Join(parts, "\n")
	default:
		b, err := json.Marshal(c)
		if err != nil {
			return ""
		}
		return string(b)
	}
}

func hasToolResults(msg types.LlmMessage) bool {
	switch c := msg.Content.(type) {
	case []types.LlmContentBlock:
		for _, b := range c {
			if b.Type == "tool_result" {
				return true
			}
		}
	case []any:
		for _, item := range c {
			if m, ok := item.(map[string]any); ok {
				if t, _ := m["type"].(string); t == "tool_result" {
					return true
				}
			}
		}
	}
	return false
}

func extractMatchingSentence(text string, pattern *regexp.Regexp) string {
	// Split on sentence boundaries and return the first match.
	sentences := splitSentences(text)
	for _, s := range sentences {
		if pattern.MatchString(s) {
			s = strings.TrimSpace(s)
			if len(s) > 200 {
				s = s[:200] + "..."
			}
			return s
		}
	}
	return ""
}

func splitSentences(text string) []string {
	// Simple sentence splitter: split on . ! ? followed by whitespace or EOL.
	re := regexp.MustCompile(`[.!?]\s+|\n`)
	indices := re.FindAllStringIndex(text, -1)
	if len(indices) == 0 {
		return []string{text}
	}

	var sentences []string
	start := 0
	for _, idx := range indices {
		sentences = append(sentences, text[start:idx[0]+1])
		start = idx[1]
	}
	if start < len(text) {
		sentences = append(sentences, text[start:])
	}
	return sentences
}
