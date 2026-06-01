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
	"github.com/dsswift/ion/engine/internal/utils"
)

// ListStored returns metadata for saved conversations on disk, sorted by
// file modification time descending. If dir is empty, defaults to
// ~/.ion/conversations/. If limit <= 0, defaults to 50.
//
// Supports both the new split format (.llm.jsonl + .tree.jsonl) and the legacy
// .jsonl format. When both exist for the same conversation ID (mid-migration),
// the new format takes precedence and the legacy file is ignored for listing
// purposes. The legacy file will be removed on the next Save.
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

	dirEntries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []types.StoredSessionInfo{}, nil
		}
		return nil, err
	}

	// Collect conversation IDs from all relevant files, deduplicated. Track
	// the mtime of the "authoritative" file per ID:
	//   - For new-format IDs: mtime of the .llm.jsonl file.
	//   - For legacy-format IDs: mtime of the .jsonl file.
	// New format takes precedence when both exist for the same ID.
	type idEntry struct {
		id        string
		mtime     int64
		isNewFmt  bool // true → use .llm.jsonl + .tree.jsonl; false → use .jsonl
	}
	byID := make(map[string]*idEntry)

	for _, e := range dirEntries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		info, err := e.Info()
		if err != nil {
			continue
		}
		mtime := info.ModTime().UnixMilli()

		switch {
		case strings.HasSuffix(name, ".llm.jsonl"):
			id := strings.TrimSuffix(name, ".llm.jsonl")
			if existing, ok := byID[id]; !ok || !existing.isNewFmt {
				byID[id] = &idEntry{id: id, mtime: mtime, isNewFmt: true}
			}

		case strings.HasSuffix(name, ".jsonl") &&
			!strings.HasSuffix(name, ".llm.jsonl") &&
			!strings.HasSuffix(name, ".tree.jsonl"):
			// Plain legacy .jsonl — only add if no new-format entry exists yet.
			id := strings.TrimSuffix(name, ".jsonl")
			if _, ok := byID[id]; !ok {
				byID[id] = &idEntry{id: id, mtime: mtime, isNewFmt: false}
			}
		}
	}

	ranked := make([]*idEntry, 0, len(byID))
	for _, e := range byID {
		ranked = append(ranked, e)
	}
	sort.Slice(ranked, func(i, j int) bool {
		return ranked[i].mtime > ranked[j].mtime
	})

	if len(ranked) > limit {
		ranked = ranked[:limit]
	}

	var results []types.StoredSessionInfo
	for _, e := range ranked {
		var info types.StoredSessionInfo
		var scanErr error
		if e.isNewFmt {
			// New format: scan .tree.jsonl for entries (first user msg, label,
			// message count), and .llm.jsonl for header metadata (model, cost).
			treePath := filepath.Join(dir, e.id+".tree.jsonl")
			llmPath := filepath.Join(dir, e.id+".llm.jsonl")
			info, scanErr = scanSplitSessionFiles(llmPath, treePath)
		} else {
			info, scanErr = scanSessionFile(filepath.Join(dir, e.id+".jsonl"))
		}
		if scanErr != nil {
			continue
		}
		results = append(results, info)
	}
	return results, nil
}

// scanSplitSessionFiles reads metadata for a conversation stored in the new
// split format. Header fields (model, cost, createdAt, ID) come from the
// .llm.jsonl header line. Content fields (firstMessage, lastAssistantText,
// messageCount, customTitle) come from walking the .tree.jsonl entries.
func scanSplitSessionFiles(llmPath, treePath string) (types.StoredSessionInfo, error) {
	// Read LLM header for metadata.
	llmFile, err := os.Open(llmPath)
	if err != nil {
		return types.StoredSessionInfo{}, err
	}
	defer func() {
		if closeErr := llmFile.Close(); closeErr != nil {
			utils.Log("conv-list", fmt.Sprintf("scanSplitSessionFiles: close %s failed: %v", llmPath, closeErr))
		}
	}()

	llmScanner := bufio.NewScanner(llmFile)
	llmScanner.Buffer(make([]byte, 0, 64*1024), maxScanTokenSize)

	var info types.StoredSessionInfo
	if llmScanner.Scan() {
		line := strings.TrimSpace(llmScanner.Text())
		var header map[string]any
		if err := json.Unmarshal([]byte(line), &header); err != nil {
			return types.StoredSessionInfo{}, fmt.Errorf("invalid llm header: %w", err)
		}
		if _, ok := header["meta"]; !ok {
			return types.StoredSessionInfo{}, fmt.Errorf("missing meta in llm header")
		}
		info.SessionID = jsonString(header, "id")
		info.Model = jsonString(header, "model")
		info.CreatedAt = int64(jsonFloat(header, "createdAt", 0))
		info.TotalCost = jsonFloat(header, "totalCost", 0)
	}

	// Read tree entries for content fields.
	treeFile, err := os.Open(treePath)
	if err != nil {
		return types.StoredSessionInfo{}, err
	}
	defer func() {
		if closeErr := treeFile.Close(); closeErr != nil {
			utils.Log("conv-list", fmt.Sprintf("scanSplitSessionFiles: close %s failed: %v", treePath, closeErr))
		}
	}()

	treeScanner := bufio.NewScanner(treeFile)
	treeScanner.Buffer(make([]byte, 0, 64*1024), maxScanTokenSize)

	headerParsed := false
	firstUserFound := false
	lastAssistantText := ""
	messageCount := 0
	customTitle := ""

	for treeScanner.Scan() {
		line := strings.TrimSpace(treeScanner.Text())
		if line == "" {
			continue
		}
		if !headerParsed {
			// Skip the tree header line.
			headerParsed = true
			continue
		}

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
			text := extractContentText(entry.Data)
			var md struct {
				Role string `json:"role"`
			}
			if err := json.Unmarshal(entry.Data, &md); err != nil {
				continue
			}
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

// scanSessionFile reads a .jsonl conversation file and extracts metadata.
func scanSessionFile(path string) (types.StoredSessionInfo, error) {
	f, err := os.Open(path)
	if err != nil {
		return types.StoredSessionInfo{}, err
	}
	defer func() {
		if err := f.Close(); err != nil {
			utils.Log("conv-list", fmt.Sprintf("scanSessionFile: close %s failed: %v", path, err))
		}
	}()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), maxScanTokenSize)

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

// PaginatedMessages holds a page of messages with total count metadata.
type PaginatedMessages struct {
	Messages []types.SessionMessage `json:"messages"`
	Total    int                    `json:"total"`
	HasMore  bool                   `json:"hasMore"`
}

// LoadMessagesPaginated loads a conversation by ID and returns a paginated
// slice of SessionMessage structs. Offset is zero-based, limit caps the page
// size. If limit is 0, all messages from offset onward are returned.
func LoadMessagesPaginated(id, dir string, offset, limit int) (*PaginatedMessages, error) {
	all, err := LoadMessages(id, dir)
	if err != nil {
		return nil, err
	}

	total := len(all)
	if offset >= total {
		return &PaginatedMessages{Messages: []types.SessionMessage{}, Total: total, HasMore: false}, nil
	}

	end := total
	if limit > 0 && offset+limit < total {
		end = offset + limit
	}

	return &PaginatedMessages{
		Messages: all[offset:end],
		Total:    total,
		HasMore:  end < total,
	}, nil
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
// Tool results are merged into their matching tool-call messages (same ToolID)
// so the client receives a single message with both call and result data.
func flattenEntries(conv *Conversation) []types.SessionMessage {
	path := getContextPathEntries(conv)

	// First pass: collect all messages and build a toolID → index map for tool calls.
	var result []types.SessionMessage
	toolCallIndex := map[string]int{} // toolID → index in result

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
					// Merge result content into the matching tool-call message.
					if idx, ok := toolCallIndex[b.ToolUseID]; ok {
						result[idx].Content = b.Content
					}
					// If no matching tool call found, drop the orphan result.
				}
			}
			if len(textParts) > 0 {
				content := strings.Join(textParts, "\n")
				result = append(result, types.SessionMessage{
					Role:      "user",
					Content:   content,
					Timestamp: entry.Timestamp,
					Internal:  isInternalMessage(content),
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
					toolCallIndex[b.ID] = len(result)
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

// isInternalMessage returns true if a user message was injected by the engine
// for LLM steering purposes. These messages should be tagged as internal so
// clients can choose to hide them.
func isInternalMessage(content string) bool {
	if strings.HasPrefix(content, "[SYSTEM] ") {
		return true
	}
	if content == "Continue from where you left off." {
		return true
	}
	return false
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}
