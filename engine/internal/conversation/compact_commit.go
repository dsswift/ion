package conversation

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// CommitCompaction atomically applies a planned message cut and inserts the
// matching tree boundary. The tree remains the durable source of truth: old
// entries stay available for history/search, while BuildContextPath resets at
// the new EntryCompaction and yields only boundary + retained messages.
//
// Retained messages are matched by LlmMessage.EntryID, never content or ordinal.
// Content matching breaks for slash invocations (raw display vs expanded LLM
// prompt); ordinal matching breaks when transient messages are present.
func CommitCompaction(conv *Conversation, cut TokenBudgetCut, data CompactionData, boundary types.LlmMessage) (string, error) {
	if conv == nil {
		return "", fmt.Errorf("commit compaction: nil conversation")
	}
	conv.lock()
	defer conv.unlock()

	if cut.CutIndex < 0 || cut.CutIndex > len(conv.Messages) {
		return "", fmt.Errorf("commit compaction: cut index %d outside message count %d", cut.CutIndex, len(conv.Messages))
	}
	retained := append([]types.LlmMessage(nil), conv.Messages[cut.CutIndex:]...)

	// LLM-only conversations have no tree. Preserve their existing contract by
	// applying the cut and in-memory boundary directly.
	if len(conv.Entries) == 0 {
		conv.Messages = append([]types.LlmMessage{boundary}, retained...)
		return "", nil
	}

	entryIndex := make(map[string]int, len(conv.Entries))
	for i := range conv.Entries {
		entryIndex[conv.Entries[i].ID] = i
	}
	type contentUpdate struct {
		entryIndex int
		data       MessageData
	}
	var updates []contentUpdate

	firstKeptID := ""
	firstKeptIdx := -1
	for i := range retained {
		if retained[i].EntryID == "" { // transient: intentionally not persisted
			continue
		}
		idx, ok := entryIndex[retained[i].EntryID]
		if !ok {
			return "", fmt.Errorf("commit compaction: retained message entry %q not found", retained[i].EntryID)
		}
		if conv.Entries[idx].Type != EntryMessage {
			return "", fmt.Errorf("commit compaction: retained id %q has type %q, want message", retained[i].EntryID, conv.Entries[idx].Type)
		}
		md := asMessageData(conv.Entries[idx].Data)
		if md == nil {
			return "", fmt.Errorf("commit compaction: message data %q cannot be decoded", retained[i].EntryID)
		}
		md.LlmContent = retained[i].Content
		// Provider usage on a retained assistant was measured before compaction
		// against the full old prefix. It is no longer a valid occupancy baseline;
		// clear it so GetContextUsage estimates until the next provider response.
		md.Usage = nil
		updates = append(updates, contentUpdate{entryIndex: idx, data: *md})
		if firstKeptID == "" {
			firstKeptID = retained[i].EntryID
			firstKeptIdx = idx
		}
	}

	// Validate every persisted retained id belongs to the active path before any
	// mutation. A stale/detached id would create a split tree and silently lose
	// context on Save.
	active := make(map[string]bool)
	for _, entry := range getContextPathEntriesLocked(conv) {
		active[entry.ID] = true
	}
	for i := range retained {
		if retained[i].EntryID != "" && !active[retained[i].EntryID] {
			return "", fmt.Errorf("commit compaction: retained entry %q is not on active path", retained[i].EntryID)
		}
	}

	compactionID := GenEntryID()
	data.FirstKeptEntryID = firstKeptID
	var oldParent *string
	if firstKeptIdx >= 0 && conv.Entries[firstKeptIdx].ParentID != nil {
		v := *conv.Entries[firstKeptIdx].ParentID
		oldParent = &v
	} else if conv.LeafID != nil {
		// No persisted suffix survived. Append the boundary after the old leaf.
		v := *conv.LeafID
		oldParent = &v
	}
	compactionEntry := SessionEntry{
		ID:        compactionID,
		ParentID:  oldParent,
		Type:      EntryCompaction,
		Timestamp: nowMillis(),
		Data:      data,
	}
	conv.Entries = append(conv.Entries, compactionEntry)

	if firstKeptIdx >= 0 {
		v := compactionID
		conv.Entries[firstKeptIdx].ParentID = &v
	} else {
		setLeafLocked(conv, compactionID)
	}

	// Persist the exact compacted content on retained entries without changing
	// display history. LlmContent is the provider-visible override; Content stays
	// the original full/raw display value. All updates were validated above,
	// before tree mutation began.
	for _, update := range updates {
		conv.Entries[update.entryIndex].Data = update.data
	}

	conv.Messages = buildContextPathLocked(conv)
	utils.LogWithFields(utils.LevelInfo, "conversation.compact", "compaction committed to tree", map[string]any{
		"conversation_id":     conv.ID,
		"compaction_entry_id": compactionID,
		"first_kept_entry_id": firstKeptID,
		"dropped_messages":    cut.Dropped,
		"retained_messages":   len(conv.Messages) - 1,
	})
	return firstKeptID, nil
}
