package conversation

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// MigrateConversation upgrades a raw JSON map to the current schema version.
func MigrateConversation(raw map[string]any) (*Conversation, error) {
	if raw == nil {
		return nil, errors.New("invalid conversation data")
	}

	// v0 -> v1: add version field
	if _, ok := raw["version"]; !ok {
		raw["version"] = float64(1)
	}

	version, _ := raw["version"].(float64)

	// v1 -> v2: convert flat messages to tree entries
	if version < 2 {
		var entries []SessionEntry
		var prevID *string

		if msgs, ok := raw["messages"].([]any); ok {
			for _, m := range msgs {
				msg, ok := m.(map[string]any)
				if !ok {
					continue
				}
				entryID := GenEntryID()
				entries = append(entries, SessionEntry{
					ID:        entryID,
					ParentID:  prevID,
					Type:      EntryMessage,
					Timestamp: int64(jsonFloat(raw, "createdAt", float64(nowMillis()))),
					Data: MessageData{
						Role:    jsonString(msg, "role"),
						Content: msg["content"],
					},
				})
				prevID = strPtr(entryID)
			}
		}

		raw["entries"] = entries
		raw["leafId"] = prevID
		raw["version"] = float64(2)
	}

	b, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("marshal during migration: %w", err)
	}
	var conv Conversation
	if err := json.Unmarshal(b, &conv); err != nil {
		return nil, fmt.Errorf("unmarshal during migration: %w", err)
	}

	if err := rehydrateEntries(&conv); err != nil {
		return nil, err
	}

	return &conv, nil
}

// rehydrateEntries re-decodes entry.Data from map[string]any into typed structs.
func rehydrateEntries(conv *Conversation) error {
	for i := range conv.Entries {
		e := &conv.Entries[i]
		raw, ok := e.Data.(map[string]any)
		if !ok {
			continue
		}
		b, err := json.Marshal(raw)
		if err != nil {
			continue
		}
		switch e.Type {
		case EntryMessage:
			var md MessageData
			if err := json.Unmarshal(b, &md); err == nil {
				e.Data = md
			}
		case EntryCompaction:
			var cd CompactionData
			if err := json.Unmarshal(b, &cd); err == nil {
				e.Data = cd
			}
		case EntryLabel:
			var ld LabelData
			if err := json.Unmarshal(b, &ld); err == nil {
				e.Data = ld
			}
		case EntryModelChange:
			var mc ModelChangeData
			if err := json.Unmarshal(b, &mc); err == nil {
				e.Data = mc
			}
		}
	}
	return nil
}

// Save persists a conversation to disk. v2+ uses JSONL, v1 uses JSON.
func Save(conv *Conversation, dir string) error {
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		dir = filepath.Join(home, ".ion", "conversations")
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	if conv.Version >= 2 && len(conv.Entries) > 0 {
		return saveJSONL(conv, dir)
	}
	return saveJSON(conv, dir)
}

func saveJSONL(conv *Conversation, dir string) error {
	savePath := filepath.Join(dir, conv.ID+".jsonl")

	header := map[string]any{
		"meta":              true,
		"id":                conv.ID,
		"version":           conv.Version,
		"model":             conv.Model,
		"system":            conv.System,
		"totalInputTokens":  conv.TotalInputTokens,
		"totalOutputTokens": conv.TotalOutputTokens,
		"lastInputTokens":   conv.LastInputTokens,
		"totalCost":         conv.TotalCost,
		"createdAt":         conv.CreatedAt,
		"leafId":            conv.LeafID,
	}
	if conv.ParentID != "" {
		header["parentId"] = conv.ParentID
	}

	var lines []string
	headerBytes, err := json.Marshal(header)
	if err != nil {
		return err
	}
	lines = append(lines, string(headerBytes))

	for _, entry := range conv.Entries {
		entryBytes, err := json.Marshal(entry)
		if err != nil {
			return err
		}
		lines = append(lines, string(entryBytes))
	}

	return writeFileSynced(savePath, []byte(strings.Join(lines, "\n")+"\n"))
}

func saveJSON(conv *Conversation, dir string) error {
	savePath := filepath.Join(dir, conv.ID+".json")
	b, err := json.MarshalIndent(conv, "", "  ")
	if err != nil {
		return err
	}
	return writeFileSynced(savePath, b)
}

// writeFileSynced writes data to path with fsync, so a crash immediately
// after the write does not lose the contents. Uses a temp file + rename
// for atomicity, then fsyncs the parent directory so the rename is durable.
func writeFileSynced(path string, data []byte) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

// Load reads a conversation from disk. Tries JSONL first, then JSON.
func Load(id, dir string) (*Conversation, error) {
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		dir = filepath.Join(home, ".ion", "conversations")
	}

	jsonlPath := filepath.Join(dir, id+".jsonl")
	if data, err := os.ReadFile(jsonlPath); err == nil {
		return loadFromJSONL(data)
	}

	jsonPath := filepath.Join(dir, id+".json")
	data, err := os.ReadFile(jsonPath)
	if err != nil {
		return nil, fmt.Errorf("conversation not found: %s", id)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	return MigrateConversation(raw)
}

func loadFromJSONL(data []byte) (*Conversation, error) {
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var lines []string
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) == 0 {
		return nil, errors.New("empty JSONL")
	}

	var header map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &header); err != nil {
		return nil, fmt.Errorf("invalid JSONL header: %w", err)
	}
	if _, ok := header["meta"]; !ok {
		return nil, errors.New("invalid JSONL header: missing meta field")
	}

	var entries []SessionEntry
	for i := 1; i < len(lines); i++ {
		var entry SessionEntry
		if err := json.Unmarshal([]byte(lines[i]), &entry); err != nil {
			return nil, fmt.Errorf("invalid entry at line %d: %w", i+1, err)
		}
		entries = append(entries, entry)
	}

	conv := &Conversation{
		ID:                jsonString(header, "id"),
		System:            jsonString(header, "system"),
		Model:             jsonString(header, "model"),
		Messages:          []types.LlmMessage{},
		TotalInputTokens:  int(jsonFloat(header, "totalInputTokens", 0)),
		TotalOutputTokens: int(jsonFloat(header, "totalOutputTokens", 0)),
		LastInputTokens:   int(jsonFloat(header, "lastInputTokens", 0)),
		TotalCost:         jsonFloat(header, "totalCost", 0),
		CreatedAt:         int64(jsonFloat(header, "createdAt", float64(nowMillis()))),
		Version:           int(jsonFloat(header, "version", 2)),
		ParentID:          jsonString(header, "parentId"),
		Entries:           entries,
	}

	if leafID, ok := header["leafId"].(string); ok {
		conv.LeafID = &leafID
	}

	if err := rehydrateEntries(conv); err != nil {
		return nil, err
	}

	conv.Messages = BuildContextPath(conv)
	return conv, nil
}
