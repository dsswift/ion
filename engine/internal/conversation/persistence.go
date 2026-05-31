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
	"github.com/dsswift/ion/engine/internal/utils"
)

// ErrNotFound is returned by Load when no conversation file exists for the
// given ID. Callers can use errors.Is(err, ErrNotFound) to distinguish
// "conversation does not exist" from "conversation exists but is corrupt or
// unreadable".
var ErrNotFound = errors.New("conversation not found")

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
		case EntryAgentDispatch:
			var ad AgentDispatchData
			if err := json.Unmarshal(b, &ad); err == nil {
				e.Data = ad
			}
		}
	}
	return nil
}

// Save persists a conversation to disk using the split sidecar format:
//
//	<id>.llm.jsonl  — header + LLM messages (authoritative for context)
//	<id>.tree.jsonl — header + tree entries + leafId (rendering/branching)
//
// If the conversation was loaded from a legacy .jsonl file (_isLegacy == true),
// Save also removes the legacy file after both new sidecars are written
// successfully. Failure to unlink the legacy file is non-fatal and logged.
//
// For brand-new conversations with no entries (version < 2 or len(Entries)==0),
// Save falls back to the legacy saveJSON path so empty-conversation saves are
// still handled gracefully.
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

	// Branch: v2 conversations with entries use the split format.
	// Conversations that have never had any turns yet (brand-new, no entries)
	// fall back to the legacy JSON path so we don't write stub files.
	if conv.Version >= 2 && len(conv.Entries) > 0 {
		return saveSplit(conv, dir)
	}
	return saveJSON(conv, dir)
}

// saveSplit writes the two sidecar files atomically in order:
//
//  1. <id>.llm.jsonl  — the LLM-authoritative context file
//  2. <id>.tree.jsonl — the rendering/branching tree
//
// Writing order matters for crash safety. If we crash between the two renames,
// the tree is one entry behind the LLM file. That is safe-direction: the LLM
// file is the authority for context correctness. The reverse (tree ahead of LLM)
// would be unsafe because the tree would imply the user "said" something the
// LLM never saw.
//
// Message body selection:
//   - When conv.Messages is nil (explicitly cleared by /clear): write header only
//     — no message lines. On reload, Messages == nil; LLM sees empty history.
//   - When conv.Messages is non-nil and Entries are present: write
//     BuildContextPath(conv) to derive the canonical message sequence from the
//     entry tree. This excludes transient messages (added via
//     AddTransientUserMessage) that are in conv.Messages but not in Entries.
//   - When conv.Messages is non-nil and no Entries: write conv.Messages as-is.
//
// After both writes succeed, any legacy .jsonl file is unlinked. Failure to
// unlink is non-fatal: the next Load will find the new pair and the next Save
// will retry the unlink.
func saveSplit(conv *Conversation, dir string) error {
	llmPath := filepath.Join(dir, conv.ID+".llm.jsonl")
	treePath := filepath.Join(dir, conv.ID+".tree.jsonl")
	legacyPath := filepath.Join(dir, conv.ID+".jsonl")

	// --- Build .llm.jsonl content: header + message body ---
	llmHeader := map[string]any{
		"meta":                    true,
		"id":                      conv.ID,
		"version":                 conv.Version,
		"model":                   conv.Model,
		"system":                  conv.System,
		"totalInputTokens":        conv.TotalInputTokens,
		"totalOutputTokens":       conv.TotalOutputTokens,
		"lastInputTokens":         conv.LastInputTokens,
		"lastInputTokensMsgCount": conv.LastInputTokensMsgCount,
		"totalCost":               conv.TotalCost,
		"createdAt":               conv.CreatedAt,
	}
	if conv.ParentID != "" {
		llmHeader["parentId"] = conv.ParentID
	}

	var llmLines []string
	llmHeaderBytes, err := json.Marshal(llmHeader)
	if err != nil {
		return fmt.Errorf("marshal llm header: %w", err)
	}
	llmLines = append(llmLines, string(llmHeaderBytes))

	// Determine which messages to write:
	//   - nil Messages means explicitly cleared — write nothing (header only).
	//   - non-nil Messages with Entries: derive from the entry tree to exclude
	//     transient messages that are in conv.Messages but not in Entries.
	//   - non-nil Messages without Entries: write conv.Messages as-is.
	var messagesToWrite []types.LlmMessage
	if conv.Messages != nil {
		if len(conv.Entries) > 0 {
			messagesToWrite = BuildContextPath(conv)
		} else {
			messagesToWrite = conv.Messages
		}
	}

	for _, msg := range messagesToWrite {
		msgBytes, err := json.Marshal(msg)
		if err != nil {
			return fmt.Errorf("marshal llm message: %w", err)
		}
		llmLines = append(llmLines, string(msgBytes))
	}

	llmData := []byte(strings.Join(llmLines, "\n") + "\n")
	if err := writeFileSynced(llmPath, llmData); err != nil {
		utils.Log("Conversation", fmt.Sprintf("Save: id=%s .llm.jsonl write failed err=%v", conv.ID, err))
		return fmt.Errorf("save llm file: %w", err)
	}

	// --- Build .tree.jsonl content: header + Entries ---
	treeHeader := map[string]any{
		"meta":             true,
		"id":               conv.ID,
		"version":          conv.Version,
		"leafId":           conv.LeafID,
		"workingDirectory": conv.WorkingDirectory,
	}

	var treeLines []string
	treeHeaderBytes, err := json.Marshal(treeHeader)
	if err != nil {
		return fmt.Errorf("marshal tree header: %w", err)
	}
	treeLines = append(treeLines, string(treeHeaderBytes))

	for _, entry := range conv.Entries {
		entryBytes, err := json.Marshal(entry)
		if err != nil {
			return fmt.Errorf("marshal tree entry: %w", err)
		}
		treeLines = append(treeLines, string(entryBytes))
	}

	treeData := []byte(strings.Join(treeLines, "\n") + "\n")
	if err := writeFileSynced(treePath, treeData); err != nil {
		utils.Log("Conversation", fmt.Sprintf("Save: id=%s .tree.jsonl write failed err=%v llmAlreadyWritten=true", conv.ID, err))
		return fmt.Errorf("save tree file: %w", err)
	}

	// Determine log mode for observability.
	mode := "new"
	if conv._isLegacy {
		mode = "migrate"
	}
	utils.Log("Conversation", fmt.Sprintf("Save: id=%s mode=%s llmBytes=%d treeBytes=%d",
		conv.ID, mode, len(llmData), len(treeData)))

	// Unlink legacy .jsonl after both new files are written. Non-fatal on
	// failure: both new files exist, so the next Load finds the new pair.
	// The next Save will retry the unlink because _isLegacy is set from the
	// on-disk probe, not from this field (which is in-memory only).
	if conv._isLegacy {
		if unlinkErr := os.Remove(legacyPath); unlinkErr != nil && !os.IsNotExist(unlinkErr) {
			utils.Log("Conversation", fmt.Sprintf("Save: id=%s mode=migrate legacy unlink failed err=%v (non-fatal — new files written)", conv.ID, unlinkErr))
		} else if unlinkErr == nil {
			utils.Log("Conversation", fmt.Sprintf("Save: id=%s mode=migrate legacy=%s removed=true", conv.ID, conv.ID+".jsonl"))
		}
		// Clear the flag so repeated saves in the same process don't re-attempt
		// on an already-removed file.
		conv._isLegacy = false
	}

	return nil
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

// Load reads a conversation from disk. Probe order:
//
//  1. <id>.llm.jsonl AND <id>.tree.jsonl both present → new split format.
//  2. <id>.jsonl present → legacy format (sets _isLegacy; migrated on next Save).
//  3. <id>.json present → v1 JSON migration path (also legacy-flagged).
//  4. Else → not found.
//
// The split probe requires BOTH files to be present. If only .llm.jsonl exists
// (e.g. a mid-migration crash left an orphan), Load falls through to the legacy
// probe. The orphan is overwritten on the next Save.
func Load(id, dir string) (*Conversation, error) {
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		dir = filepath.Join(home, ".ion", "conversations")
	}

	llmPath := filepath.Join(dir, id+".llm.jsonl")
	treePath := filepath.Join(dir, id+".tree.jsonl")
	jsonlPath := filepath.Join(dir, id+".jsonl")
	jsonPath := filepath.Join(dir, id+".json")

	// Probe 1: new split format — both files must exist.
	_, llmErr := os.Stat(llmPath)
	_, treeErr := os.Stat(treePath)
	if llmErr == nil && treeErr == nil {
		return loadSplit(id, llmPath, treePath)
	}

	// Probe 2: legacy .jsonl
	if data, err := os.ReadFile(jsonlPath); err == nil {
		conv, err := loadFromJSONL(data)
		if err != nil {
			return nil, err
		}
		conv._isLegacy = true
		utils.Log("Conversation", fmt.Sprintf("Load: id=%s path=legacy entries=%d messages=%d lastInputTokens=%d — will migrate on next save",
			conv.ID, len(conv.Entries), len(conv.Messages), conv.LastInputTokens))
		return conv, nil
	}

	// Probe 3: v1 JSON migration
	data, err := os.ReadFile(jsonPath)
	if err != nil {
		utils.Log("Conversation", fmt.Sprintf("Load: id=%s not found (probed %s, %s, %s)",
			id, llmPath, jsonlPath, jsonPath))
		return nil, fmt.Errorf("%w: %s", ErrNotFound, id)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	conv, err := MigrateConversation(raw)
	if err != nil {
		return nil, err
	}
	conv._isLegacy = true
	utils.Log("Conversation", fmt.Sprintf("Load: id=%s path=v1json entries=%d messages=%d lastInputTokens=%d — will migrate on next save",
		conv.ID, len(conv.Entries), len(conv.Messages), conv.LastInputTokens))
	return conv, nil
}

// loadSplit reads both sidecar files and merges them into a single Conversation.
//
// Field sourcing:
//   - Header metadata (ID, Model, System, token counters, cost, etc.) — from .llm.jsonl.
//   - Messages (LLM context) — from .llm.jsonl body lines. NOT rebuilt via
//     BuildContextPath; whatever is in the file is the authoritative LLM context.
//   - Entries, LeafID, WorkingDirectory — from .tree.jsonl.
//
// This is the critical correctness guarantee: /clear zeros Messages and saves
// .llm.jsonl with an empty body. On the next Load, Messages == nil because
// we trust the file, not because we re-derive from Entries.
func loadSplit(id, llmPath, treePath string) (*Conversation, error) {
	// --- Parse .llm.jsonl ---
	llmData, err := os.ReadFile(llmPath)
	if err != nil {
		return nil, fmt.Errorf("read llm file %s: %w", llmPath, err)
	}

	llmLines, err := scanNonEmptyLines(llmData)
	if err != nil {
		return nil, fmt.Errorf("scan llm file %s: %w", llmPath, err)
	}
	if len(llmLines) == 0 {
		return nil, fmt.Errorf("empty llm file: %s", llmPath)
	}

	var llmHeader map[string]any
	if err := json.Unmarshal([]byte(llmLines[0]), &llmHeader); err != nil {
		return nil, fmt.Errorf("invalid llm header in %s: %w", llmPath, err)
	}
	if _, ok := llmHeader["meta"]; !ok {
		return nil, fmt.Errorf("missing meta field in llm header: %s", llmPath)
	}

	var messages []types.LlmMessage
	for i := 1; i < len(llmLines); i++ {
		var msg types.LlmMessage
		if err := json.Unmarshal([]byte(llmLines[i]), &msg); err != nil {
			return nil, fmt.Errorf("invalid message at line %d in %s: %w", i+1, llmPath, err)
		}
		messages = append(messages, msg)
	}

	// --- Parse .tree.jsonl ---
	treeData, err := os.ReadFile(treePath)
	if err != nil {
		return nil, fmt.Errorf("read tree file %s: %w", treePath, err)
	}

	treeLines, err := scanNonEmptyLines(treeData)
	if err != nil {
		return nil, fmt.Errorf("scan tree file %s: %w", treePath, err)
	}
	if len(treeLines) == 0 {
		return nil, fmt.Errorf("empty tree file: %s", treePath)
	}

	var treeHeader map[string]any
	if err := json.Unmarshal([]byte(treeLines[0]), &treeHeader); err != nil {
		return nil, fmt.Errorf("invalid tree header in %s: %w", treePath, err)
	}
	if _, ok := treeHeader["meta"]; !ok {
		return nil, fmt.Errorf("missing meta field in tree header: %s", treePath)
	}

	var entries []SessionEntry
	for i := 1; i < len(treeLines); i++ {
		var entry SessionEntry
		if err := json.Unmarshal([]byte(treeLines[i]), &entry); err != nil {
			return nil, fmt.Errorf("invalid entry at line %d in %s: %w", i+1, treePath, err)
		}
		entries = append(entries, entry)
	}

	// --- Merge into Conversation ---
	conv := &Conversation{
		// Header fields from .llm.jsonl (canonical metadata source)
		ID:                      jsonString(llmHeader, "id"),
		System:                  jsonString(llmHeader, "system"),
		Model:                   jsonString(llmHeader, "model"),
		TotalInputTokens:        int(jsonFloat(llmHeader, "totalInputTokens", 0)),
		TotalOutputTokens:       int(jsonFloat(llmHeader, "totalOutputTokens", 0)),
		LastInputTokens:         int(jsonFloat(llmHeader, "lastInputTokens", 0)),
		LastInputTokensMsgCount: int(jsonFloat(llmHeader, "lastInputTokensMsgCount", 0)),
		TotalCost:               jsonFloat(llmHeader, "totalCost", 0),
		CreatedAt:               int64(jsonFloat(llmHeader, "createdAt", float64(nowMillis()))),
		Version:                 int(jsonFloat(llmHeader, "version", 2)),
		ParentID:                jsonString(llmHeader, "parentId"),
		// LLM context from .llm.jsonl body — verbatim, NOT rebuilt from Entries
		Messages: messages,
		// Tree fields from .tree.jsonl
		Entries:          entries,
		WorkingDirectory: jsonString(treeHeader, "workingDirectory"),
	}

	if leafID, ok := treeHeader["leafId"].(string); ok {
		conv.LeafID = &leafID
	}

	if err := rehydrateEntries(conv); err != nil {
		return nil, err
	}

	utils.Log("Conversation", fmt.Sprintf("Load: id=%s path=new entries=%d messages=%d lastInputTokens=%d lastInputTokensMsgCount=%d",
		conv.ID, len(conv.Entries), len(conv.Messages), conv.LastInputTokens, conv.LastInputTokensMsgCount))
	return conv, nil
}

// loadFromJSONL parses a legacy .jsonl conversation file (header + entries).
// After parsing, it reconstructs Messages via BuildContextPath. This is the
// legacy code path only — new-format loads use loadSplit, which reads Messages
// verbatim from .llm.jsonl and never calls BuildContextPath.
func loadFromJSONL(data []byte) (*Conversation, error) {
	lines, err := scanNonEmptyLines(data)
	if err != nil {
		return nil, err
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
		ID:                      jsonString(header, "id"),
		System:                  jsonString(header, "system"),
		Model:                   jsonString(header, "model"),
		Messages:                []types.LlmMessage{},
		TotalInputTokens:        int(jsonFloat(header, "totalInputTokens", 0)),
		TotalOutputTokens:       int(jsonFloat(header, "totalOutputTokens", 0)),
		LastInputTokens:         int(jsonFloat(header, "lastInputTokens", 0)),
		LastInputTokensMsgCount: int(jsonFloat(header, "lastInputTokensMsgCount", 0)),
		TotalCost:               jsonFloat(header, "totalCost", 0),
		CreatedAt:               int64(jsonFloat(header, "createdAt", float64(nowMillis()))),
		Version:                 int(jsonFloat(header, "version", 2)),
		ParentID:                jsonString(header, "parentId"),
		Entries:                 entries,
	}

	if leafID, ok := header["leafId"].(string); ok {
		conv.LeafID = &leafID
	}

	if err := rehydrateEntries(conv); err != nil {
		return nil, err
	}

	// Legacy path only: rebuild Messages from the entry tree. The new-format
	// path (loadSplit) trusts .llm.jsonl verbatim to avoid re-leaking cleared
	// history — this is the root cause of issue #146.
	conv.Messages = BuildContextPath(conv)
	return conv, nil
}

// scanNonEmptyLines splits JSONL bytes into non-empty trimmed lines using a
// buffered scanner with a 1 MB per-line limit.
func scanNonEmptyLines(data []byte) ([]string, error) {
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var lines []string
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			lines = append(lines, line)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return lines, nil
}
