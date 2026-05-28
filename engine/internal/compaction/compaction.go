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
	"github.com/dsswift/ion/engine/internal/utils"
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

// MaxFactsPerSection caps the number of facts FormatFactsSummary renders
// per section before collapsing the remainder into a "... (+N more)"
// overflow line. Without the cap a single noisy compaction round (e.g. a
// build dumping a hundred file paths through tool results) generates a
// summary so long it consumes most of the post-compaction window — the
// opposite of what compaction is supposed to do.
//
// 20 is a starting point chosen to fit comfortably in a screen of
// markdown while still surfacing enough detail to be useful. Tune by
// tests, not by feel; the cap is a contract the compaction tests pin.
const MaxFactsPerSection = 20

// ExtractFacts scans messages for patterns and returns structured facts.
//
// Facts are deduplicated within a single pass by (Type, Content) so a
// file path mentioned in N tool results contributes one bullet, not N.
// Cross-pass deduplication is handled at the caller layer via
// conversation.MessagesAfterLastCompactBoundary, which prevents earlier
// boundary summaries from being re-scanned — see the gentle-knitting-cup
// plan for the structural rationale.
func ExtractFacts(messages []types.LlmMessage) []Fact {
	utils.Debug("Compaction", fmt.Sprintf("ExtractFacts: scanning %d messages", len(messages)))
	var facts []Fact
	// (Type, Content) dedupe key. The map value is unused — we only need
	// presence. Using a string key sidesteps tuple-key gymnastics; the
	// pipe character is reserved-safe because neither Type nor Content
	// contains it in the patterns we emit.
	seen := make(map[string]struct{})
	add := func(f Fact) {
		key := f.Type + "|" + f.Content
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		facts = append(facts, f)
	}

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
					add(Fact{Type: "file_mod", Content: p, Source: i})
				}
			}
		}

		if decisionPatterns.MatchString(text) {
			sentence := extractMatchingSentence(text, decisionPatterns)
			if sentence != "" {
				add(Fact{Type: "decision", Content: sentence, Source: i})
			}
		}

		if errorPatterns.MatchString(text) {
			sentence := extractMatchingSentence(text, errorPatterns)
			if sentence != "" {
				add(Fact{Type: "error", Content: sentence, Source: i})
			}
		}

		if preferencePatterns.MatchString(text) {
			sentence := extractMatchingSentence(text, preferencePatterns)
			if sentence != "" {
				add(Fact{Type: "preference", Content: sentence, Source: i})
			}
		}

		if discoveryPatterns.MatchString(text) {
			sentence := extractMatchingSentence(text, discoveryPatterns)
			if sentence != "" {
				add(Fact{Type: "discovery", Content: sentence, Source: i})
			}
		}
	}

	// Log fact counts by category.
	counts := make(map[string]int)
	for _, f := range facts {
		counts[f.Type]++
	}
	utils.Debug("Compaction", fmt.Sprintf("ExtractFacts: done total=%d decisions=%d file_mods=%d errors=%d preferences=%d discoveries=%d",
		len(facts), counts["decision"], counts["file_mod"], counts["error"], counts["preference"], counts["discovery"]))

	return facts
}

// FormatFactsSummary formats extracted facts into a human-readable
// summary grouped by type.
//
// Each section is capped at MaxFactsPerSection bullets; any remainder is
// collapsed to a "... (+N more)" line. The cap protects against
// pathological cases where a single noisy turn produced dozens of
// matches — without it the summary itself can blow the context budget
// it was meant to reclaim.
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

		// Render up to the cap; collapse the rest. The collapsed-count
		// line is appended only when there are excess items, so capped
		// sections look identical to uncapped ones below the threshold.
		shown := items
		if len(items) > MaxFactsPerSection {
			shown = items[:MaxFactsPerSection]
		}
		for _, f := range shown {
			fmt.Fprintf(&sb, "- %s\n", f.Content)
		}
		if len(items) > MaxFactsPerSection {
			fmt.Fprintf(&sb, "- ... (+%d more)\n", len(items)-MaxFactsPerSection)
		}
		sb.WriteString("\n")
	}

	return strings.TrimSpace(sb.String())
}

// BuildCompactBoundaryMessage is a thin re-export of
// conversation.BuildCompactBoundaryMessage so the compaction package
// stays a one-stop shop for runloop callers that already import it
// without forcing them to also import conversation. The argument shape
// (CompactMeta) is the conversation-package type; the alias exists for
// convenience only — both call sites produce byte-identical wire output.
//
// The constructor itself lives in the conversation package to break a
// would-be import cycle: tree.go's BuildContextPath needs to reconstruct
// boundary blocks from CompactionData and lives in conversation; the
// compaction package depends on conversation, never the reverse.
func BuildCompactBoundaryMessage(meta conversation.CompactMeta) types.LlmMessage {
	return conversation.BuildCompactBoundaryMessage(meta)
}

// CompactMeta is re-exported from conversation for the same reason as
// BuildCompactBoundaryMessage above — callers that already import
// compaction can construct boundary metadata without a second import.
type CompactMeta = conversation.CompactMeta

// CompactPartial removes entries from a conversation tree, keeping everything
// after pivotEntryID. Direction is "before" (remove older) or "after" (remove newer).
func CompactPartial(conv *conversation.Conversation, pivotEntryID string, direction string) error {
	utils.Debug("Compaction", fmt.Sprintf("CompactPartial: pivotID=%s direction=%s entries=%d", pivotEntryID, direction, len(conv.Entries)))
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
		utils.Warn("Compaction", fmt.Sprintf("CompactPartial: pivot not found: %s", pivotEntryID))
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

	utils.Debug("Compaction", fmt.Sprintf("CompactPartial: complete direction=%s entriesAfter=%d", direction, len(conv.Entries)))
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

	utils.Debug("Compaction", fmt.Sprintf("ExtractRecentFiles: found %d files from %d messages", len(files), len(messages)))
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
