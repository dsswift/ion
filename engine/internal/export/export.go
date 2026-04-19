// Package export converts conversations to various output formats (JSON,
// Markdown, HTML) with optional secret redaction.
package export

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// Options configures the export behavior.
type Options struct {
	Format        string // "json", "markdown", "html", "jsonl"
	RedactSecrets bool
	FullTree      bool // When true, export all entries; when false, export active branch only (jsonl).
}

// ExportSession renders a conversation in the requested format.
func ExportSession(conv *conversation.Conversation, opts Options) (string, error) {
	if conv == nil {
		return "", fmt.Errorf("conversation is nil")
	}

	switch strings.ToLower(opts.Format) {
	case "json", "":
		return exportJSON(conv)
	case "markdown", "md":
		return exportMarkdown(conv, opts.RedactSecrets), nil
	case "html":
		return exportHTML(conv, opts.RedactSecrets), nil
	case "jsonl":
		return exportJSONL(conv, opts)
	default:
		return "", fmt.Errorf("unsupported format: %s", opts.Format)
	}
}

func exportJSON(conv *conversation.Conversation) (string, error) {
	b, err := json.MarshalIndent(conv, "", "  ")
	if err != nil {
		return "", fmt.Errorf("json marshal: %w", err)
	}
	return string(b), nil
}

func exportMarkdown(conv *conversation.Conversation, redact bool) string {
	var sb strings.Builder

	sb.WriteString("# Session: " + conv.ID + "\n\n")
	sb.WriteString("- **Model**: " + conv.Model + "\n")
	sb.WriteString("- **Created**: " + time.UnixMilli(conv.CreatedAt).Format(time.RFC3339) + "\n")
	sb.WriteString(fmt.Sprintf("- **Cost**: $%.4f\n", conv.TotalCost))
	sb.WriteString(fmt.Sprintf("- **Tokens**: %d in / %d out\n", conv.TotalInputTokens, conv.TotalOutputTokens))
	sb.WriteString("\n---\n\n")

	for _, msg := range conv.Messages {
		role := capitalize(msg.Role)
		sb.WriteString("### " + role + "\n\n")

		text := extractText(msg)
		if redact {
			text = redactSecretPatterns(text)
		}
		sb.WriteString(text + "\n\n")
	}

	return strings.TrimSpace(sb.String())
}

func exportHTML(conv *conversation.Conversation, redact bool) string {
	var sb strings.Builder

	sb.WriteString(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Session: ` + html.EscapeString(conv.ID) + `</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
.meta { color: #666; font-size: 0.9em; margin-bottom: 20px; }
.message { margin-bottom: 16px; padding: 12px; border-radius: 8px; }
.user { background: #e8f0fe; }
.assistant { background: #f0f0f0; }
.role { font-weight: bold; margin-bottom: 4px; }
.tool-result { background: #f8f8f8; border: 1px solid #ddd; padding: 8px; border-radius: 4px; margin: 4px 0; font-family: monospace; font-size: 0.85em; white-space: pre-wrap; }
details { margin: 4px 0; }
summary { cursor: pointer; color: #555; }
pre { white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
`)

	sb.WriteString("<h1>Session: " + html.EscapeString(conv.ID) + "</h1>\n")
	sb.WriteString("<div class=\"meta\">\n")
	sb.WriteString("<p>Model: " + html.EscapeString(conv.Model) + "</p>\n")
	sb.WriteString("<p>Created: " + time.UnixMilli(conv.CreatedAt).Format(time.RFC3339) + "</p>\n")
	sb.WriteString(fmt.Sprintf("<p>Cost: $%.4f | Tokens: %d in / %d out</p>\n",
		conv.TotalCost, conv.TotalInputTokens, conv.TotalOutputTokens))
	sb.WriteString("</div>\n")

	for _, msg := range conv.Messages {
		class := msg.Role
		sb.WriteString("<div class=\"message " + class + "\">\n")
		sb.WriteString("<div class=\"role\">" + html.EscapeString(capitalize(msg.Role)) + "</div>\n")

		blocks := extractBlocks(msg)
		for _, block := range blocks {
			if block.isToolResult {
				sb.WriteString("<details><summary>Tool Result</summary>\n")
				text := block.text
				if redact {
					text = redactSecretPatterns(text)
				}
				sb.WriteString("<div class=\"tool-result\">" + html.EscapeString(text) + "</div>\n")
				sb.WriteString("</details>\n")
			} else {
				text := block.text
				if redact {
					text = redactSecretPatterns(text)
				}
				sb.WriteString("<pre>" + html.EscapeString(text) + "</pre>\n")
			}
		}
		sb.WriteString("</div>\n")
	}

	sb.WriteString("</body>\n</html>")
	return sb.String()
}

type textBlock struct {
	text         string
	isToolResult bool
}

func extractBlocks(msg types.LlmMessage) []textBlock {
	switch c := msg.Content.(type) {
	case string:
		return []textBlock{{text: c}}
	case []types.LlmContentBlock:
		var blocks []textBlock
		for _, b := range c {
			switch b.Type {
			case "text":
				if b.Text != "" {
					blocks = append(blocks, textBlock{text: b.Text})
				}
			case "tool_result":
				blocks = append(blocks, textBlock{text: b.Content, isToolResult: true})
			case "tool_use":
				name := b.Name
				if name == "" {
					name = "tool_use"
				}
				inputJSON, _ := json.Marshal(b.Input)
				blocks = append(blocks, textBlock{text: name + ": " + string(inputJSON)})
			}
		}
		return blocks
	case []any:
		var blocks []textBlock
		for _, item := range c {
			if m, ok := item.(map[string]any); ok {
				t, _ := m["type"].(string)
				switch t {
				case "text":
					if text, ok := m["text"].(string); ok {
						blocks = append(blocks, textBlock{text: text})
					}
				case "tool_result":
					if text, ok := m["content"].(string); ok {
						blocks = append(blocks, textBlock{text: text, isToolResult: true})
					}
				}
			}
		}
		return blocks
	}
	return nil
}

func extractText(msg types.LlmMessage) string {
	blocks := extractBlocks(msg)
	var parts []string
	for _, b := range blocks {
		if b.text != "" {
			parts = append(parts, b.text)
		}
	}
	return strings.Join(parts, "\n")
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// redactSecretPatterns is a lightweight redaction for export. For full scanning,
// use the insights package's RedactSecrets function.
func redactSecretPatterns(text string) string {
	replacements := []struct {
		prefix string
		redact string
	}{
		{"ghp_", "[REDACTED:github_token]"},
		{"gho_", "[REDACTED:github_token]"},
		{"sk_live_", "[REDACTED:stripe_key]"},
		{"sk_test_", "[REDACTED:stripe_key]"},
		{"sk-ant-", "[REDACTED:anthropic_key]"},
		{"xoxb-", "[REDACTED:slack_token]"},
		{"xoxp-", "[REDACTED:slack_token]"},
		{"AKIA", "[REDACTED:aws_key]"},
	}

	result := text
	for _, r := range replacements {
		for {
			idx := strings.Index(result, r.prefix)
			if idx < 0 {
				break
			}
			end := idx + len(r.prefix)
			for end < len(result) && result[end] != ' ' && result[end] != '\n' && result[end] != '\t' && result[end] != '"' && result[end] != '\'' {
				end++
			}
			result = result[:idx] + r.redact + result[end:]
		}
	}
	return result
}

func exportJSONL(conv *conversation.Conversation, opts Options) (string, error) {
	entries := conv.Entries
	if !opts.FullTree && conv.LeafID != nil {
		entries = filterActiveBranch(conv.Entries, *conv.LeafID)
	}

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	for _, entry := range entries {
		if opts.RedactSecrets {
			entry = redactEntry(entry)
		}
		if err := enc.Encode(entry); err != nil {
			return "", fmt.Errorf("jsonl encode: %w", err)
		}
	}
	return buf.String(), nil
}

func filterActiveBranch(entries []conversation.SessionEntry, leafID string) []conversation.SessionEntry {
	entryMap := make(map[string]*conversation.SessionEntry, len(entries))
	for i := range entries {
		entryMap[entries[i].ID] = &entries[i]
	}

	// Walk from leaf to root, collecting IDs on the active path.
	pathIDs := make(map[string]bool)
	current := entryMap[leafID]
	for current != nil {
		pathIDs[current.ID] = true
		if current.ParentID != nil {
			current = entryMap[*current.ParentID]
		} else {
			current = nil
		}
	}

	var result []conversation.SessionEntry
	for _, e := range entries {
		if pathIDs[e.ID] {
			result = append(result, e)
		}
	}
	return result
}

// redactEntry returns a copy of the entry with secret patterns removed from
// any text content in the Data field.
func redactEntry(entry conversation.SessionEntry) conversation.SessionEntry {
	if entry.Type != conversation.EntryMessage {
		return entry
	}

	// Try to redact text within the data. We re-serialize, redact, then
	// leave as raw JSON (map[string]any) so the encoder can handle it.
	b, err := json.Marshal(entry.Data)
	if err != nil {
		return entry
	}
	redacted := redactSecretPatterns(string(b))
	var raw any
	if json.Unmarshal([]byte(redacted), &raw) == nil {
		entry.Data = raw
	}
	return entry
}
