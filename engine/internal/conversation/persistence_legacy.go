package conversation

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

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

	entries := make([]SessionEntry, 0, len(lines)-1)
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
	if repairLegacyRecoveryState(conv) {
		utils.LogWithFields(utils.LevelInfo, "conversation.recovery_repair", "legacy recovery content repaired in memory", map[string]any{"conversation_id": conv.ID})
	}
	validateAndRepairTree(conv)
	conv.Messages = BuildContextPath(conv)
	rehydrateMessageUsage(conv)
	return conv, nil
}
