package conversation

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// AppendEntry adds an entry to the tree, chained from the current leaf.
// Safe for concurrent use; see lock.go for the package locking discipline.
func AppendEntry(conv *Conversation, entryType SessionEntryType, data any) *SessionEntry {
	conv.lock()
	defer conv.unlock()
	return appendEntryLocked(conv, entryType, data, "")
}

// Branch moves the leaf pointer to an existing entry and rebuilds the message list.
func Branch(conv *Conversation, entryID string) ([]types.LlmMessage, error) {
	conv.lock()
	defer conv.unlock()
	if conv.Entries == nil {
		return conv.Messages, nil
	}
	found := false
	for _, e := range conv.Entries {
		if e.ID == entryID {
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("entry not found: %s", entryID)
	}
	setLeafLocked(conv, entryID)
	conv.Messages = buildContextPathLocked(conv)
	return conv.Messages, nil
}

// BuildContextPath walks from the current leaf to the root and extracts messages.
// Safe for concurrent use.
func BuildContextPath(conv *Conversation) []types.LlmMessage {
	conv.lock()
	defer conv.unlock()
	return buildContextPathLocked(conv)
}

// buildContextPathLocked is BuildContextPath's body; callers must hold conv.mu.
func buildContextPathLocked(conv *Conversation) []types.LlmMessage {
	if conv.Entries == nil || conv.LeafID == nil {
		return conv.Messages
	}

	path := getContextPathEntriesLocked(conv)

	var messages []types.LlmMessage
	for _, entry := range path {
		switch entry.Type {
		case EntryMessage:
			md := asMessageData(entry.Data)
			if md != nil {
				// DisplayOnly entries (e.g. the `context: fork` raw invocation
				// recorded for scrollback) are in the tree for the user but were
				// never part of the LLM context — skip them so a rebuilt
				// .llm.jsonl does not resurrect a turn the model never saw.
				if md.DisplayOnly {
					continue
				}
				msg := types.LlmMessage{Role: md.Role, Content: md.Content}
				if md.Role == "assistant" && md.Usage != nil {
					msg.Usage = md.Usage
				}
				messages = append(messages, msg)
			}
		case EntryCompaction:
			// A compaction entry marks a boundary: everything before it
			// was dropped from the LLM context. Discard accumulated
			// messages and restart from the compaction summary. This
			// ensures that Save (which calls BuildContextPath to derive
			// the .llm.jsonl content) writes only the post-compaction
			// context — not the full pre-compaction history that the
			// tree preserves for user viewing.
			cd := asCompactionData(entry.Data)
			messages = nil
			if cd != nil {
				// Reconstruct the boundary as a typed compact_boundary
				// block so a rebuilt context path is byte-identical to a
				// freshly-injected one (see runloop_compaction.go). The
				// original CompactionData record only persists Summary +
				// FirstKeptEntryID + TokensBefore, so the reconstructed
				// boundary carries those fields and leaves the rest
				// zero-valued — Trigger is unknown after a rebuild, the
				// fact count is not persisted, etc. Consumers handle
				// missing fields uniformly because they're all optional.
				messages = append(messages, BuildCompactBoundaryMessage(CompactMeta{
					Trigger:      "auto", // historical reconstructions default to auto; original trigger is not persisted
					Summary:      cd.Summary,
					TokensBefore: cd.TokensBefore,
				}))
			}
		}
	}
	return messages
}

// NavigateTree moves the leaf pointer to target and rebuilds messages.
func NavigateTree(conv *Conversation, targetID string) ([]types.LlmMessage, error) {
	return Branch(conv, targetID)
}

// BranchBefore moves the leaf pointer to the PARENT of the given entry and
// rebuilds the message list. This is the tree-native rewind primitive: a
// consumer rewinding "to before user turn X" branches at X's parent so the
// next appended turn becomes X's sibling — replacing it on the active path —
// instead of chaining after the old leaf and duplicating it. When the entry
// is a root (no parent), the leaf clears and the context path empties: the
// next turn starts a fresh branch from the top.
func BranchBefore(conv *Conversation, entryID string) ([]types.LlmMessage, error) {
	conv.lock()
	defer conv.unlock()
	if conv.Entries == nil {
		return conv.Messages, nil
	}
	var parent *string
	found := false
	for i := range conv.Entries {
		if conv.Entries[i].ID == entryID {
			parent = conv.Entries[i].ParentID
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("entry not found: %s", entryID)
	}
	if parent == nil {
		conv.LeafID = nil
		conv.Messages = nil
		return conv.Messages, nil
	}
	setLeafLocked(conv, *parent)
	conv.Messages = buildContextPathLocked(conv)
	return conv.Messages, nil
}

// GetTree builds the full tree structure for visualization.
func GetTree(conv *Conversation) []TreeNode {
	conv.lock()
	defer conv.unlock()
	if len(conv.Entries) == 0 {
		return nil
	}

	childMap := make(map[string][]SessionEntry)
	for _, entry := range conv.Entries {
		key := ""
		if entry.ParentID != nil {
			key = *entry.ParentID
		}
		childMap[key] = append(childMap[key], entry)
	}

	var buildNode func(SessionEntry) TreeNode
	buildNode = func(entry SessionEntry) TreeNode {
		children := childMap[entry.ID]
		nodes := make([]TreeNode, len(children))
		for i, child := range children {
			nodes[i] = buildNode(child)
		}
		return TreeNode{Entry: entry, Children: nodes}
	}

	roots := childMap[""]
	result := make([]TreeNode, len(roots))
	for i, r := range roots {
		result[i] = buildNode(r)
	}
	return result
}

// GetBranchPoints returns entries that have more than one child.
func GetBranchPoints(conv *Conversation) []SessionEntry {
	conv.lock()
	defer conv.unlock()
	if len(conv.Entries) == 0 {
		return nil
	}

	childCount := make(map[string]int)
	for _, e := range conv.Entries {
		if e.ParentID != nil {
			childCount[*e.ParentID]++
		}
	}

	entryMap := buildEntryMap(conv.Entries)
	var result []SessionEntry
	for id, count := range childCount {
		if count > 1 {
			if e, ok := entryMap[id]; ok {
				result = append(result, e)
			}
		}
	}
	return result
}

// GetLeaves returns entries with no children.
func GetLeaves(conv *Conversation) []SessionEntry {
	conv.lock()
	defer conv.unlock()
	if len(conv.Entries) == 0 {
		return nil
	}

	hasChildren := make(map[string]bool)
	for _, e := range conv.Entries {
		if e.ParentID != nil {
			hasChildren[*e.ParentID] = true
		}
	}

	var result []SessionEntry
	for _, e := range conv.Entries {
		if !hasChildren[e.ID] {
			result = append(result, e)
		}
	}
	return result
}

// ForkConversation forks at a message index. For v2 trees, uses branch in-place.
// For legacy v1 conversations, creates a new conversation with copied messages.
func ForkConversation(conv *Conversation, atMessageIndex int) *Conversation {
	if len(conv.Entries) > 0 {
		path := getContextPathEntries(conv)
		var messageEntries []SessionEntry
		for _, e := range path {
			if e.Type == EntryMessage {
				messageEntries = append(messageEntries, e)
			}
		}
		idx := atMessageIndex
		if idx >= len(messageEntries) {
			idx = len(messageEntries) - 1
		}
		if idx >= 0 && idx < len(messageEntries) {
			_, _ = Branch(conv, messageEntries[idx].ID)
		}
		return conv
	}

	newID := fmt.Sprintf("fork-%s-%d", conv.ID, nowMillis())
	idx := atMessageIndex
	if idx >= len(conv.Messages) {
		idx = len(conv.Messages) - 1
	}
	if idx < 0 {
		idx = 0
	}

	forked := make([]types.LlmMessage, idx+1)
	for i := 0; i <= idx; i++ {
		forked[i] = types.LlmMessage{
			Role:    conv.Messages[i].Role,
			Content: conv.Messages[i].Content,
		}
	}

	return &Conversation{
		ID:        newID,
		System:    conv.System,
		Model:     conv.Model,
		Messages:  forked,
		CreatedAt: nowMillis(),
		Version:   CurrentVersion,
		ParentID:  conv.ID,
		LeafID:    nil,
	}
}

func getContextPathEntries(conv *Conversation) []SessionEntry {
	conv.lock()
	defer conv.unlock()
	return getContextPathEntriesLocked(conv)
}

// getContextPathEntriesLocked walks leaf → root and returns the path in
// root-first order. Callers must hold conv.mu.
//
// A walk that stops on a missing parent is silent data loss unless the stop
// is the designed partial-compaction boundary (the truncated first file-order
// entry legitimately references a dropped parent). Every other miss — a
// missing leaf, or a mid-chain dangling parent — is logged at ERROR so a
// truncated history can never again pass as a successful load.
func getContextPathEntriesLocked(conv *Conversation) []SessionEntry {
	if conv.Entries == nil || conv.LeafID == nil {
		return nil
	}
	entryMap := buildEntryMap(conv.Entries)

	var path []SessionEntry
	current, ok := entryMap[*conv.LeafID]
	if !ok {
		utils.LogWithFields(utils.LevelError, "conversation", "context path: leaf id not found in entries", map[string]any{
			"conversation_id": conv.ID,
			"leaf_id":         *conv.LeafID,
			"total_entries":   len(conv.Entries),
		})
	}
	for ok {
		path = append(path, current)
		if current.ParentID == nil {
			break
		}
		next, found := entryMap[*current.ParentID]
		if !found {
			// The truncated first file-order entry keeping a reference to its
			// dropped parent is partial-compaction working as designed; any
			// other dangling parent is a broken chain.
			if len(conv.Entries) == 0 || current.ID != conv.Entries[0].ID {
				utils.LogWithFields(utils.LevelError, "conversation", "context path: dangling parent truncated walk", map[string]any{
					"conversation_id": conv.ID,
					"stopped_at":      current.ID,
					"missing_parent":  *current.ParentID,
					"path_len":        len(path),
					"total_entries":   len(conv.Entries),
				})
			}
			break
		}
		current = next
	}

	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return path
}

func buildEntryMap(entries []SessionEntry) map[string]SessionEntry {
	m := make(map[string]SessionEntry, len(entries))
	for _, e := range entries {
		m[e.ID] = e
	}
	return m
}
