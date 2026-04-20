package conversation

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// ListStored returns metadata for saved conversations on disk, sorted by
// file modification time descending. If dir is empty, defaults to
// ~/.ion/conversations/. If limit <= 0, defaults to 50.
func ListStored(dir string, limit int) ([]types.StoredSessionInfo, error) {
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		dir = filepath.Join(home, ".ion", "conversations")
	}
	if limit <= 0 {
		limit = 50
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []types.StoredSessionInfo{}, nil
		}
		return nil, err
	}

	type fileEntry struct {
		path  string
		mtime int64
	}
	var files []fileEntry
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, fileEntry{
			path:  filepath.Join(dir, e.Name()),
			mtime: info.ModTime().UnixMilli(),
		})
	}

	sort.Slice(files, func(i, j int) bool {
		return files[i].mtime > files[j].mtime
	})

	if len(files) > limit {
		files = files[:limit]
	}

	var results []types.StoredSessionInfo
	for _, f := range files {
		info, err := scanSessionFile(f.path)
		if err != nil {
			continue
		}
		results = append(results, info)
	}
	return results, nil
}

// scanSessionFile reads a .jsonl conversation file and extracts metadata.
func scanSessionFile(path string) (types.StoredSessionInfo, error) {
	f, err := os.Open(path)
	if err != nil {
		return types.StoredSessionInfo{}, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var info types.StoredSessionInfo
	headerParsed := false
	firstUserFound := false
	lastAssistantText := ""
	messageCount := 0
	customTitle := ""

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		if !headerParsed {
			var header map[string]any
			if err := json.Unmarshal([]byte(line), &header); err != nil {
				return types.StoredSessionInfo{}, fmt.Errorf("invalid header: %w", err)
			}
			if _, ok := header["meta"]; !ok {
				return types.StoredSessionInfo{}, fmt.Errorf("missing meta field")
			}
			info.SessionID = jsonString(header, "id")
			info.Model = jsonString(header, "model")
			info.CreatedAt = int64(jsonFloat(header, "createdAt", 0))
			info.TotalCost = jsonFloat(header, "totalCost", 0)
			headerParsed = true
			continue
		}

		// Parse entry
		var entry struct {
			Type string          `json:"type"`
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}

		switch SessionEntryType(entry.Type) {
		case EntryMessage:
			messageCount++
			var md struct {
				Role    string `json:"role"`
				Content any    `json:"content"`
			}
			if err := json.Unmarshal(entry.Data, &md); err != nil {
				continue
			}
			text := extractContentText(entry.Data)
			if md.Role == "user" && !firstUserFound && text != "" {
				info.FirstMessage = truncate(text, 200)
				firstUserFound = true
			}
			if md.Role == "assistant" && text != "" {
				lastAssistantText = text
			}

		case EntryLabel:
			var ld struct {
				Label *string `json:"label"`
			}
			if err := json.Unmarshal(entry.Data, &ld); err == nil && ld.Label != nil {
				customTitle = *ld.Label
			}
		}
	}

	info.MessageCount = messageCount
	info.LastMessage = truncate(lastAssistantText, 100)
	info.CustomTitle = customTitle

	return info, nil
}

// extractContentText pulls text from a MessageData's Content field,
// which may be a string or an array of content blocks.
func extractContentText(dataRaw json.RawMessage) string {
	var md struct {
		Role    string `json:"role"`
		Content any    `json:"content"`
	}
	if err := json.Unmarshal(dataRaw, &md); err != nil {
		return ""
	}

	// Try as string first
	var strContent struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(dataRaw, &strContent); err == nil && strContent.Content != "" {
		return strContent.Content
	}

	// Try as array of content blocks
	var arrContent struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(dataRaw, &arrContent); err == nil {
		var parts []string
		for _, b := range arrContent.Content {
			if b.Type == "text" && b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n")
	}

	return ""
}

// LoadMessages loads a conversation by ID and returns a flat list of
// SessionMessage structs suitable for client display.
func LoadMessages(id, dir string) ([]types.SessionMessage, error) {
	conv, err := Load(id, dir)
	if err != nil {
		return nil, err
	}

	return flattenEntries(conv), nil
}

// LoadChainMessages loads multiple conversations by ID and concatenates
// their messages in order.
func LoadChainMessages(ids []string, dir string) ([]types.SessionMessage, error) {
	var all []types.SessionMessage
	for _, id := range ids {
		msgs, err := LoadMessages(id, dir)
		if err != nil {
			return nil, fmt.Errorf("loading session %s: %w", id, err)
		}
		all = append(all, msgs...)
	}
	return all, nil
}

// flattenEntries walks the context path entries and produces SessionMessages.
func flattenEntries(conv *Conversation) []types.SessionMessage {
	path := getContextPathEntries(conv)
	var result []types.SessionMessage

	for _, entry := range path {
		if entry.Type != EntryMessage {
			continue
		}
		md := asMessageData(entry.Data)
		if md == nil {
			continue
		}

		blocks := contentToBlocks(md.Content)
		switch md.Role {
		case "user":
			var textParts []string
			for _, b := range blocks {
				switch b.Type {
				case "text":
					if b.Text != "" {
						textParts = append(textParts, b.Text)
					}
				case "tool_result":
					// Emit as a separate tool result message
					result = append(result, types.SessionMessage{
						Role:      "tool_result",
						Content:   b.Content,
						ToolID:    b.ToolUseID,
						Timestamp: entry.Timestamp,
					})
				}
			}
			if len(textParts) > 0 {
				result = append(result, types.SessionMessage{
					Role:      "user",
					Content:   strings.Join(textParts, "\n"),
					Timestamp: entry.Timestamp,
				})
			}

		case "assistant":
			for _, b := range blocks {
				switch b.Type {
				case "text":
					if b.Text != "" {
						result = append(result, types.SessionMessage{
							Role:      "assistant",
							Content:   b.Text,
							Timestamp: entry.Timestamp,
						})
					}
				case "tool_use":
					inputJSON := ""
					if b.Input != nil {
						raw, err := json.Marshal(b.Input)
						if err == nil {
							inputJSON = string(raw)
						}
					}
					result = append(result, types.SessionMessage{
						Role:      "tool",
						ToolName:  b.Name,
						ToolID:    b.ID,
						ToolInput: inputJSON,
						Timestamp: entry.Timestamp,
					})
				}
			}
		}
	}

	return result
}

// contentToBlocks converts a MessageData.Content (which may be string,
// []types.LlmContentBlock, or []any) into a uniform []types.LlmContentBlock.
func contentToBlocks(content any) []types.LlmContentBlock {
	switch c := content.(type) {
	case string:
		return []types.LlmContentBlock{{Type: "text", Text: c}}
	case []types.LlmContentBlock:
		return c
	case []any:
		raw, err := json.Marshal(c)
		if err != nil {
			return nil
		}
		var blocks []types.LlmContentBlock
		if err := json.Unmarshal(raw, &blocks); err != nil {
			return nil
		}
		return blocks
	default:
		raw, err := json.Marshal(c)
		if err != nil {
			return nil
		}
		var blocks []types.LlmContentBlock
		if err := json.Unmarshal(raw, &blocks); err != nil {
			return nil
		}
		return blocks
	}
}

// AddLabelEntry appends a label entry to the conversation tree.
func AddLabelEntry(conv *Conversation, label string) {
	AppendEntry(conv, EntryLabel, LabelData{
		Label: &label,
	})
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}
